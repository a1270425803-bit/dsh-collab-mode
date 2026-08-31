import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  linkSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import {
  RouteCatalogStore,
  canonicalJson,
  routeCatalogError,
  routeEntryDigest,
} from '../dsh-route-catalog/index.mjs';

export const name = 'r21-route-binding';
export const inject = ['tools', 'subagents', 'llm', 'agents'];

const PREFIX = 'r21-route-v1:';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const NATIVE_TOOLS = new Set([
  'subagent_scout',
  'subagent_scout_flash',
  'subagent_executor',
  'subagent_executor_flash',
  'subagent_reviewer',
  'subagent_reviewer_qwen',
  'subagent_reviewer_vl',
]);
const DEFAULT_EFFORTS = new Map([
  ['openai-codex/gpt-5.6-luna', 'max'],
  ['openai-codex/gpt-5.6-sol', 'medium'],
  ['kimi-coding/k3-256k', 'high'],
]);
const SAFE_ID = /^[A-Za-z0-9_-]{16,128}$/;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180e\u2800]/u;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw routeCatalogError('ROUTE_BINDING_INVALID', `${label} must be an object`);
  }
  return value;
}

function safeText(value, label, max = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || UNSAFE.test(value)) {
    throw routeCatalogError('ROUTE_BINDING_INVALID', `${label} is invalid`);
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function agentId(agent) {
  const value = agent?.id ?? agent?.session?.id ?? agent?.session?.header?.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sessionId(agent) {
  const value = agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function depth(agent) {
  const value = agent?.options?.subagentDepth;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parentSession(agent) {
  return agent?.session?.header?.parentSession
    ?? agent?.session?.parentSession
    ?? agent?.session?.meta?.parentSession;
}

function eventSeq(event, fallback) {
  return Number.isSafeInteger(event?.seq) && event.seq >= 0 ? event.seq : fallback;
}

function eventMessage(event) {
  const message = event?.data?.message ?? event?.data;
  return message && typeof message === 'object' ? message : null;
}

function messageText(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((block) => {
    if (typeof block === 'string') return block;
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).join('');
}

function eventId(event, index) {
  const value = event?.id ?? event?.data?.id ?? event?.data?.message?.id;
  if (typeof value === 'string' && value.length > 0) return value;
  return Number.isSafeInteger(event?.seq) ? `seq:${event.seq}` : `index:${index}`;
}

function directMessages(agent) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
  return events.map((event, index) => {
    if (event?.type !== 'user/message') return null;
    const message = eventMessage(event);
    if (message?.role !== 'user' || message?.source?.kind !== 'user') return null;
    return {
      id: eventId(event, index),
      seq: eventSeq(event, index),
      text: messageText(message),
    };
  }).filter(Boolean);
}

function assertRoot(ctx, exec) {
  const agent = exec?.agent;
  if (!agent || depth(agent) !== 0 || parentSession(agent) != null) {
    throw routeCatalogError('ROUTE_BINDING_UNAUTHORIZED', 'route binding requires the root agent');
  }
  const rootAgentId = agentId(agent);
  const currentSessionId = sessionId(agent);
  if (!rootAgentId || !currentSessionId || typeof ctx?.agents?.currentInitiator !== 'function') {
    throw routeCatalogError('ROUTE_BINDING_UNAUTHORIZED', 'root identity is unavailable');
  }
  if (ctx.agents.currentInitiator() !== agent) {
    throw routeCatalogError('ROUTE_BINDING_UNAUTHORIZED', 'calling agent is not the current root initiator');
  }
  if (typeof ctx.agents.get === 'function' && ctx.agents.get(rootAgentId) !== agent) {
    throw routeCatalogError('ROUTE_BINDING_UNAUTHORIZED', 'calling root is not the live agent');
  }
  const messages = directMessages(agent);
  const latest = messages.at(-1);
  if (!latest) throw routeCatalogError('ROUTE_BINDING_UNAUTHORIZED', 'no direct user message is available');
  return { agent, rootAgentId, initiatorAgentId: rootAgentId, sessionId: currentSessionId, messages, latest };
}

function ensureDir(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    stat = lstatSync(dir);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw routeCatalogError('ROUTE_BINDING_UNAVAILABLE', 'binding directory is not a real directory', { dir });
  }
  chmodSync(dir, 0o700);
  stat = lstatSync(dir);
  if ((stat.mode & 0o777) !== 0o700) {
    throw routeCatalogError('ROUTE_BINDING_UNAVAILABLE', 'binding directory permissions are unsafe', { dir });
  }
}

function assertPrivateFile(file, missingCode = 'ROUTE_SNAPSHOT_UNAVAILABLE') {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw routeCatalogError(missingCode, 'binding file is missing', { file });
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw routeCatalogError('ROUTE_BINDING_UNAVAILABLE', 'binding file must be a private regular file', { file });
  }
}

function writeOnce(file, dir, value, conflictCode) {
  ensureDir(dir);
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(value)}\n`, undefined, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    if (error?.code === 'EEXIST') throw routeCatalogError(conflictCode, 'binding state already exists', { file });
    throw error;
  }
}

function readJson(file, missingCode) {
  assertPrivateFile(file, missingCode);
  try {
    return record(JSON.parse(readFileSync(file, 'utf8')), path.basename(file));
  } catch (error) {
    if (error?.code?.startsWith?.('ROUTE_')) throw error;
    throw routeCatalogError('ROUTE_SNAPSHOT_UNAVAILABLE', 'binding state is not valid JSON', { file, cause: error });
  }
}

function listFiles(dir) {
  ensureDir(dir);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name));
}

function parseLabel(label) {
  if (typeof label !== 'string' || !label.startsWith(PREFIX)) return null;
  const match = new RegExp(`^${PREFIX}([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{24})$`).exec(label);
  if (!match) throw routeCatalogError('ROUTE_SNAPSHOT_UNAVAILABLE', 'continuable route label is malformed');
  return { token: match[1], dispatchRef: match[2] };
}

function descriptorLabel(token, dispatchRef) {
  return `${PREFIX}${safeText(token, 'token', 64)}:${safeText(dispatchRef, 'dispatch_ref', 128)}`;
}

function descriptorOf(agent) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
  const event = [...events].reverse().find((item) => item?.type === 'subagent/descriptor');
  return event?.data?.label ?? event?.data?.descriptor?.label ?? null;
}

function validateBinding(value, expectedRef = undefined) {
  record(value, 'binding');
  for (const key of ['version', 'dispatch_ref', 'token', 'descriptor_label', 'target_tool', 'route_id', 'provider', 'model', 'route_digest', 'parent_agent_id', 'parent_session_id', 'user_event_id', 'user_event_digest', 'dispatch_label_digest', 'created_at', 'expires_at', 'snapshot_digest']) {
    if (value[key] === undefined) throw routeCatalogError('ROUTE_BINDING_INVALID', `binding lacks ${key}`);
  }
  if (value.version !== 1 || !SAFE_ID.test(value.dispatch_ref) || expectedRef !== undefined && value.dispatch_ref !== expectedRef) {
    throw routeCatalogError('ROUTE_BINDING_INVALID', 'binding identity is invalid');
  }
  safeText(value.token, 'token', 64);
  safeText(value.descriptor_label, 'descriptor_label', 160);
  if (value.descriptor_label !== descriptorLabel(value.token, value.dispatch_ref)) {
    throw routeCatalogError('ROUTE_BINDING_INVALID', 'binding descriptor label does not match token');
  }
  for (const field of ['target_tool', 'route_id', 'provider', 'model', 'route_digest', 'parent_agent_id', 'parent_session_id', 'user_event_id', 'user_event_digest', 'dispatch_label_digest', 'created_at', 'expires_at', 'snapshot_digest']) safeText(value[field], `binding.${field}`, 4096);
  if (!NATIVE_TOOLS.has(value.target_tool)) throw routeCatalogError('ROUTE_BINDING_INVALID', 'binding target tool is not native');
  if (value.reasoningEffort !== undefined) safeText(value.reasoningEffort, 'binding.reasoningEffort', 80);
  return value;
}

function validateSnapshot(value, expectedRef, token) {
  record(value, 'snapshot');
  if (value.version !== 1 || value.dispatch_ref !== expectedRef || value.token !== token) {
    throw routeCatalogError('ROUTE_SNAPSHOT_UNAVAILABLE', 'snapshot identity is invalid');
  }
  for (const field of ['dispatch_ref', 'token', 'target_tool', 'route_id', 'provider', 'model', 'route_digest', 'parent_agent_id', 'parent_session_id', 'user_event_id', 'user_event_digest', 'dispatch_label_digest', 'created_at', 'expires_at']) safeText(value[field], `snapshot.${field}`, 4096);
  if (value.reasoningEffort !== undefined) safeText(value.reasoningEffort, 'snapshot.reasoningEffort', 80);
  if (!NATIVE_TOOLS.has(value.target_tool)) throw routeCatalogError('ROUTE_SNAPSHOT_UNAVAILABLE', 'snapshot target tool is not native');
  return value;
}

const SNAPSHOT_FIELDS = [
  'version', 'dispatch_ref', 'token', 'descriptor_label', 'target_tool', 'route_id',
  'provider', 'model', 'reasoningEffort', 'route_digest', 'parent_agent_id',
  'parent_session_id', 'user_event_id', 'user_event_digest', 'dispatch_label_digest',
  'created_at', 'expires_at',
];

function assertSnapshotBinding(snapshot, binding) {
  if (binding.snapshot_digest !== digest(snapshot)) {
    throw routeCatalogError('ROUTE_SNAPSHOT_CONFLICT', 'claimed binding does not match snapshot digest');
  }
  for (const field of SNAPSHOT_FIELDS) {
    if (binding[field] !== snapshot[field]) {
      throw routeCatalogError('ROUTE_SNAPSHOT_CONFLICT', `claimed binding ${field} does not match snapshot`);
    }
  }
  return binding;
}

function assertSnapshotRoute(snapshot, route) {
  if (!route
    || routeEntryDigest(route) !== snapshot.route_digest
    || route.provider !== snapshot.provider
    || route.model !== snapshot.model
    || route.reasoningEffort !== snapshot.reasoningEffort) {
    throw routeCatalogError('ROUTE_SNAPSHOT_CONFLICT', 'snapshot route identity no longer matches shared catalog');
  }
  return route;
}

function claimedBindingForSnapshot(claimedDir, snapshot) {
  const snapshotDigest = digest(snapshot);
  const matches = listFiles(claimedDir)
    .map((file) => validateBinding(readJson(file, 'ROUTE_BINDING_UNAVAILABLE')))
    .filter((binding) => binding.dispatch_ref === snapshot.dispatch_ref
      && binding.token === snapshot.token
      && binding.snapshot_digest === snapshotDigest);
  if (matches.length !== 1) {
    throw routeCatalogError(
      'ROUTE_SNAPSHOT_UNAVAILABLE',
      matches.length === 0
        ? 'no claimed binding proves this route was consumed'
        : 'multiple claimed bindings prove this route was consumed',
    );
  }
  return assertSnapshotBinding(snapshot, matches[0]);
}

function exactEffort(ctx, route, signal) {
  if (route.reasoningEffort === undefined) return Promise.resolve(route);
  if (typeof ctx?.llm?.resolveModelInfo !== 'function') {
    return Promise.reject(routeCatalogError('ROUTE_UNSUPPORTED_EFFORT', 'exact model metadata is unavailable'));
  }
  return Promise.resolve(ctx.llm.resolveModelInfo(route.provider, route.model, signal)).then((info) => {
    const efforts = info?.reasoning?.efforts;
    if (info?.provider !== route.provider || info?.id !== route.model || !Array.isArray(efforts)) {
      throw routeCatalogError('ROUTE_UNSUPPORTED_EFFORT', 'provider/model metadata is not exact');
    }
    const ids = efforts.map((item) => item?.id).filter((id) => typeof id === 'string');
    if (!ids.includes(route.reasoningEffort)) {
      throw routeCatalogError('ROUTE_UNSUPPORTED_EFFORT', `${route.provider}/${route.model} does not support ${route.reasoningEffort}`);
    }
    return { ...route, supportedReasoningEfforts: ids };
  });
}

async function discoveredCandidates(llm, query) {
  if (typeof llm?.listProviders !== 'function' || typeof llm?.listModels !== 'function') return [];
  const q = String(typeof query === 'string' ? query : query?.query ?? query?.model ?? '').trim().toLocaleLowerCase();
  const providers = await Promise.resolve(llm.listProviders());
  const result = [];
  for (const entry of Array.isArray(providers) ? providers : []) {
    const provider = typeof entry === 'string' ? entry : entry?.id;
    if (typeof provider !== 'string') continue;
    let models;
    try { models = await llm.listModels(provider); } catch { continue; }
    for (const modelEntry of Array.isArray(models) ? models : []) {
      const model = typeof modelEntry === 'string' ? modelEntry : modelEntry?.id;
      if (typeof model !== 'string') continue;
      const label = `${provider} ${model} ${modelEntry?.name ?? ''}`.toLocaleLowerCase();
      if (!q || label.includes(q)) result.push({ provider, model, ...(typeof modelEntry?.name === 'string' ? { name: modelEntry.name } : {}) });
    }
  }
  return result;
}

function roleDefault(route) {
  return DEFAULT_EFFORTS.get(`${route.provider}/${route.model}`);
}

function safeCallId(callId) {
  return digest(String(callId ?? randomBytes(8).toString('hex'))).slice(7, 39);
}

function claimBinding(source, claimedDir, binding, callId) {
  ensureDir(claimedDir);
  const target = path.join(claimedDir, `${safeCallId(callId)}-${binding.dispatch_ref}.json`);
  try {
    linkSync(source, target);
  } catch (error) {
    if (error?.code === 'EEXIST') throw routeCatalogError('ROUTE_BINDING_CONFLICT', 'route binding was already claimed');
    throw error;
  }
  unlinkSync(source);
  return target;
}

function renderJson(_args, value) {
  return [{ type: 'text', text: canonicalJson(value) }];
}

function installCatalogTools(ctx, store) {
  ctx.tools.register({
    name: 'route_catalog_list',
    description: 'List the shared model route catalog without credentials.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      assertRoot(ctx, exec);
      const catalog = store.readCatalog();
      return { preset: catalog.preset, revision: catalog.revision, catalog_digest: catalog.catalog_digest, routes: catalog.routes };
    },
  });
  ctx.tools.register({
    name: 'route_catalog_resolve',
    description: 'Resolve an exact route id, alias, or provider/model; ambiguity returns candidates.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertRoot(ctx, exec);
      const query = args.query ?? { provider: args.provider, model: args.model, reasoningEffort: args.reasoningEffort };
      const result = store.resolve(query);
      return result.status === 'unmatched'
        ? { ...result, discovered_candidates: await discoveredCandidates(ctx.llm, query) }
        : result;
    },
  });
  ctx.tools.register({
    name: 'route_catalog_propose',
    description: 'Propose an unknown exact provider/model route; confirmation is required before publication.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['route_id', 'provider', 'model'],
      properties: { route_id: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const authority = assertRoot(ctx, exec);
      const route = { route_id: args.route_id, provider: args.provider, model: args.model, ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }), ...(args.aliases === undefined ? {} : { aliases: args.aliases }) };
      if (store.resolve({ route_id: route.route_id }).status === 'resolved') throw routeCatalogError('ROUTE_ID_CONFLICT', 'route_id is already registered');
      await exactEffort(ctx, route, exec.signal);
      const proposal = store.createProposal({
        route,
        root_agent_id: authority.rootAgentId,
        initiator_agent_id: authority.initiatorAgentId,
        session_id: authority.sessionId,
        proposed_turn: null,
        proposed_seq: authority.latest.seq,
      });
      return { kind: 'route_proposal', proposal_id: proposal.proposal_id, route: proposal.route, digest: proposal.digest, expires_at: proposal.expires_at, confirmation_phrase: proposal.confirmation_phrase };
    },
  });
  ctx.tools.register({
    name: 'route_catalog_confirm',
    description: 'Confirm a route proposal only when the exact phrase appears in the latest direct user message.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['proposal_id', 'confirmation_phrase'],
      properties: { proposal_id: { type: 'string' }, confirmation_phrase: { type: 'string' } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const authority = assertRoot(ctx, exec);
      const proposal = store.readProposal(args.proposal_id);
      if (proposal.root_agent_id !== authority.rootAgentId || proposal.session_id !== authority.sessionId || proposal.confirmation_phrase !== args.confirmation_phrase) {
        throw routeCatalogError('ROUTE_BINDING_UNAUTHORIZED', 'proposal authority or phrase mismatch');
      }
      if (authority.latest.seq <= proposal.proposed_seq || !authority.latest.text.includes(proposal.confirmation_phrase)) {
        throw routeCatalogError('ROUTE_BINDING_UNAUTHORIZED', 'exact confirmation must be in a later direct user message');
      }
      await exactEffort(ctx, proposal.route, exec.signal);
      return store.confirmProposal({ proposal_id: proposal.proposal_id, confirmation_phrase: proposal.confirmation_phrase, root_agent_id: authority.rootAgentId, initiator_agent_id: authority.initiatorAgentId, session_id: authority.sessionId });
    },
  });
}

export function apply(ctx, config = {}) {
  if (!ctx?.tools?.register || !ctx?.subagents?.registerContinuableSetup) {
    throw routeCatalogError('ROUTE_SEAM_UNSUPPORTED', 'native tools/subagent continuable seams are unavailable');
  }
  const catalogDir = config.catalogDir;
  if (typeof catalogDir !== 'string' || !path.isAbsolute(catalogDir)) throw routeCatalogError('ROUTE_CATALOG_UNAVAILABLE', 'catalogDir must be absolute');
  const store = new RouteCatalogStore(catalogDir, { preset: config.catalogPreset ?? 'shared', proposalTtlMs: config.proposalTtlMs });
  store.assertReady();
  const bindingDir = path.join(store.catalogDir, 'bindings');
  const snapshotDir = path.join(store.catalogDir, 'snapshots');
  const claimedDir = path.join(bindingDir, 'claimed');
  ensureDir(bindingDir);
  ensureDir(snapshotDir);
  ensureDir(claimedDir);
  const ttlMs = Number.isSafeInteger(config.bindingTtlMs) && config.bindingTtlMs > 0 ? config.bindingTtlMs : DEFAULT_TTL_MS;
  const active = new AsyncLocalStorage();
  const pending = new WeakMap();

  installCatalogTools(ctx, store);
  ctx.tools.register({
    name: 'route_bind_once',
    description: 'Bind one exact shared route to one native subagent tool call. The returned label must be used as that call description.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['user_event_id', 'quoted_directive', 'target_tool', 'dispatch_label', 'route_id'],
      properties: {
        user_event_id: { type: 'string' }, quoted_directive: { type: 'string' }, target_tool: { type: 'string' }, dispatch_label: { type: 'string' }, route_id: { type: 'string' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const authority = assertRoot(ctx, exec);
      safeText(args.user_event_id, 'user_event_id', 512);
      safeText(args.quoted_directive, 'quoted_directive', 4096);
      safeText(args.dispatch_label, 'dispatch_label', 512);
      if (!NATIVE_TOOLS.has(args.target_tool)) throw routeCatalogError('ROUTE_BINDING_SCOPE_MISMATCH', 'target_tool is not an allowed native subagent tool');
      if (authority.latest.id !== args.user_event_id || !authority.latest.text.includes(args.quoted_directive)) {
        throw routeCatalogError('ROUTE_BINDING_UNAUTHORIZED', 'user_event_id or quoted directive is not the latest direct user event');
      }
      const route = store.getRoute(args.route_id);
      if (!route) throw routeCatalogError('ROUTE_NOT_FOUND', `route ${args.route_id} is not registered`, { candidates: store.resolve(args.route_id).candidates });
      const resolved = await exactEffort(ctx, route, exec.signal);
      const labelDigest = digest(args.dispatch_label);
      const currentBindings = listFiles(bindingDir).map((file) => validateBinding(readJson(file, 'ROUTE_BINDING_UNAVAILABLE')));
      if (currentBindings.some((binding) => binding.parent_session_id === authority.sessionId && binding.user_event_id === args.user_event_id && binding.target_tool === args.target_tool && binding.dispatch_label_digest === labelDigest)) {
        throw routeCatalogError('ROUTE_BINDING_CONFLICT', 'an equivalent route binding already exists');
      }
      const token = randomBytes(16).toString('base64url');
      const dispatchRef = randomBytes(18).toString('base64url');
      const now = Date.now();
      const snapshot = {
        version: 1,
        dispatch_ref: dispatchRef,
        token,
        descriptor_label: descriptorLabel(token, dispatchRef),
        target_tool: args.target_tool,
        route_id: resolved.route_id,
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
        route_digest: routeEntryDigest(resolved),
        parent_agent_id: authority.rootAgentId,
        parent_session_id: authority.sessionId,
        user_event_id: args.user_event_id,
        user_event_digest: digest(authority.latest.text),
        dispatch_label_digest: labelDigest,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttlMs).toISOString(),
      };
      const binding = { ...snapshot, snapshot_digest: digest(snapshot) };
      writeOnce(path.join(snapshotDir, `${dispatchRef}.json`), snapshotDir, snapshot, 'ROUTE_SNAPSHOT_CONFLICT');
      try {
        writeOnce(path.join(bindingDir, `${dispatchRef}.json`), bindingDir, binding, 'ROUTE_BINDING_CONFLICT');
      } catch (error) {
        try { unlinkSync(path.join(snapshotDir, `${dispatchRef}.json`)); } catch {}
        throw error;
      }
      return { dispatch_ref: dispatchRef, descriptor_label: snapshot.descriptor_label, route_id: resolved.route_id, provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }), expires_at: snapshot.expires_at };
    },
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const label = exec?.arguments?.description;
    if (typeof label !== 'string') return next();
    const parsed = parseLabel(label);
    if (parsed === null) return next();
    const source = path.join(bindingDir, `${parsed.dispatchRef}.json`);
    let binding;
    try {
      binding = validateBinding(readJson(source, 'ROUTE_SNAPSHOT_UNAVAILABLE'), parsed.dispatchRef);
    } catch (error) {
      if (error?.code === 'ROUTE_SNAPSHOT_UNAVAILABLE') throw error;
      throw routeCatalogError('ROUTE_BINDING_UNAVAILABLE', 'route binding could not be validated', { cause: error });
    }
    if (Date.parse(binding.expires_at) <= Date.now()) throw routeCatalogError('ROUTE_BINDING_EXPIRED', 'route binding has expired');
    if (binding.target_tool !== exec.name) throw routeCatalogError('ROUTE_BINDING_SCOPE_MISMATCH', 'route binding target tool does not match call');
    if (agentId(exec.agent) !== binding.parent_agent_id || sessionId(exec.agent) !== binding.parent_session_id) throw routeCatalogError('ROUTE_BINDING_SCOPE_MISMATCH', 'route binding parent/session does not match call');
    const route = store.getRoute(binding.route_id);
    const snapshot = validateSnapshot(
      readJson(path.join(snapshotDir, `${parsed.dispatchRef}.json`), 'ROUTE_SNAPSHOT_UNAVAILABLE'),
      parsed.dispatchRef,
      parsed.token,
    );
    assertSnapshotRoute(snapshot, route);
    assertSnapshotBinding(snapshot, binding);
    const claimedPath = claimBinding(source, claimedDir, binding, exec.callId);
    pending.set(exec, { ...binding, claimed_path: claimedPath });
    return next();
  });

  ctx.on('tools/execute', async (exec, next) => {
    const binding = pending.get(exec);
    if (!binding) return next();
    return active.run(binding, async () => {
      try { return await next(); } finally { pending.delete(exec); }
    });
  });

  ctx.subagents.registerContinuableSetup((childCtx) => {
    const parsed = parseLabel(descriptorOf(childCtx?.agent));
    if (parsed === null) {
      if (typeof childCtx?.on !== 'function') throw routeCatalogError('ROUTE_SEAM_UNSUPPORTED', 'child context lacks agent/request seam');
      return childCtx.on('agent/request', async (_payload, next) => {
        const resolved = await next();
        if (!resolved) return resolved;
        const effort = roleDefault(resolved);
        if (!effort || resolved.reasoningEffort === effort) return resolved;
        return { ...resolved, reasoningEffort: effort };
      });
    }
    const snapshot = validateSnapshot(
      readJson(path.join(snapshotDir, `${parsed.dispatchRef}.json`), 'ROUTE_SNAPSHOT_UNAVAILABLE'),
      parsed.dispatchRef,
      parsed.token,
    );
    const current = active.getStore();
    if (current && (current.dispatch_ref !== parsed.dispatchRef || current.token !== parsed.token)) {
      throw routeCatalogError('ROUTE_BINDING_SCOPE_MISMATCH', 'continuable setup is outside its bound dispatch');
    }
    const route = store.getRoute(snapshot.route_id);
    assertSnapshotRoute(snapshot, route);
    claimedBindingForSnapshot(claimedDir, snapshot);
    if (typeof childCtx?.on !== 'function') throw routeCatalogError('ROUTE_SEAM_UNSUPPORTED', 'child context lacks agent/request seam');
    return childCtx.on('agent/request', async (_payload, next) => {
      const resolved = await next();
      if (!resolved) return resolved;
      const out = { ...resolved, provider: snapshot.provider, model: snapshot.model };
      delete out.reasoningEffort;
      if (snapshot.reasoningEffort !== undefined) out.reasoningEffort = snapshot.reasoningEffort;
      return out;
    });
  });
}
