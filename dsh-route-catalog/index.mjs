import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

export const ROUTE_CATALOG_VERSION = 1;
export const DEFAULT_PROPOSAL_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CATALOG_LOCK_WAIT_MS = 5 * 1000;
export const DEFAULT_CATALOG_LOCK_STALE_MS = 30 * 1000;
export const CATALOG_LOCK_FILE = 'catalog.lock';

const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const ROUTE_ID_STRENGTH_SUFFIX = /(?:^|[_-])(?:off|none|minimal|low|medium|high|xhigh|max)$/i;
const RESERVED_ROUTE_IDS = new Set(['current_main', 'custom']);
const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
const MAX_ALIAS_LENGTH = 160;
const MAX_PROVIDER_LENGTH = 200;
const MAX_MODEL_LENGTH = 300;
const MAX_PRESET_LENGTH = 120;
const UNSAFE_STRING_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180e\u2800]/u;
const ROUTE_POLICY_KEYS = new Set([
  'route_id', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'aliases',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw routeCatalogError('ROUTE_CATALOG_INVALID', `${label} must be an object`);
  return value;
}

export function routeCatalogError(code, message, details = undefined) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

/** Stable lossless JSON encoding used by catalog, proposal, and entry digests. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError('route catalog digest cannot encode this number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new TypeError('route catalog digest cannot encode this value');
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function assertSafeString(value, label, maximum) {
  const text = nonEmptyString(value, label, maximum);
  if (UNSAFE_STRING_PATTERN.test(text)) {
    throw routeCatalogError(
      'ROUTE_CATALOG_INVALID',
      `${label} contains control, bidi, format, or invisible characters`,
    );
  }
  return text;
}

function nonEmptyString(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw routeCatalogError('ROUTE_CATALOG_INVALID', `${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function normalizeAlias(value) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function routePolicy(route) {
  return {
    route_id: route.route_id,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
    aliases: route.aliases ?? [],
  };
}

/** Digest of routing identity only; bookkeeping and authority metadata are excluded. */
export function routeEntryDigest(route) {
  return sha256(routePolicy(route));
}

function allowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw routeCatalogError('ROUTE_CATALOG_INVALID', `${label} contains unsupported field ${key}`);
  }
}

/** Validate and detach a route without accepting credentials, task text, or paths. */
export function normalizeRouteEntry(input, expectedRouteId = undefined) {
  const value = assertRecord(input, 'route entry');
  allowedKeys(value, new Set([
    'route_id', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'aliases',
    'created_at', 'approval_ref', 'digest',
  ]), 'route entry');
  const routeId = assertSafeString(value.route_id ?? expectedRouteId, 'route_id', 96);
  if (!ROUTE_ID_PATTERN.test(routeId)
    || ROUTE_ID_STRENGTH_SUFFIX.test(routeId)
    || RESERVED_ROUTE_IDS.has(routeId.toLocaleLowerCase())
    || expectedRouteId !== undefined && routeId !== expectedRouteId) {
    throw routeCatalogError('ROUTE_CATALOG_INVALID', `route_id ${routeId} is invalid`);
  }
  const provider = assertSafeString(value.provider, `${routeId}.provider`, MAX_PROVIDER_LENGTH);
  const model = assertSafeString(value.model, `${routeId}.model`, MAX_MODEL_LENGTH);
  let reasoningEffort;
  if (value.reasoningEffort !== undefined) {
    reasoningEffort = assertSafeString(value.reasoningEffort, `${routeId}.reasoningEffort`, 80);
  }
  let maxTokens;
  if (value.maxTokens !== undefined) {
    if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0) {
      throw routeCatalogError('ROUTE_CATALOG_INVALID', `${routeId}.maxTokens is invalid`);
    }
    maxTokens = value.maxTokens;
  }
  let aliases = [];
  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases) || value.aliases.length > 32) {
      throw routeCatalogError('ROUTE_CATALOG_INVALID', `${routeId}.aliases must be an array of at most 32 strings`);
    }
    const seen = new Set();
    aliases = value.aliases.map((alias) => {
      const text = assertSafeString(alias, `${routeId}.alias`, MAX_ALIAS_LENGTH);
      const normalized = normalizeAlias(text);
      if (normalized.length === 0 || seen.has(normalized)) {
        throw routeCatalogError('ROUTE_CATALOG_INVALID', `${routeId}.aliases contain duplicates or blank values`);
      }
      seen.add(normalized);
      return text;
    });
  }
  const route = {
    route_id: routeId,
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    aliases,
  };
  if (value.created_at !== undefined) route.created_at = assertSafeString(value.created_at, `${routeId}.created_at`, 80);
  if (value.approval_ref !== undefined) route.approval_ref = assertSafeString(value.approval_ref, `${routeId}.approval_ref`, 200);
  const digest = routeEntryDigest(route);
  if (value.digest !== undefined && value.digest !== digest) {
    throw routeCatalogError('ROUTE_CATALOG_TAMPERED', `${routeId}.digest does not match route policy`);
  }
  route.digest = digest;
  return route;
}

function catalogPolicy(catalog) {
  return {
    version: catalog.version,
    preset: catalog.preset,
    revision: catalog.revision,
    routes: catalog.routes,
  };
}

export function catalogDigest(catalog) {
  return sha256(catalogPolicy(catalog));
}

function makeCatalog(input, expectedPreset = undefined) {
  const value = assertRecord(input, 'route catalog');
  allowedKeys(value, new Set(['version', 'preset', 'revision', 'updated_at', 'routes', 'catalog_digest']), 'route catalog');
  if (value.version !== ROUTE_CATALOG_VERSION) {
    throw routeCatalogError('ROUTE_CATALOG_INVALID', `unsupported catalog version ${String(value.version)}`);
  }
  const preset = assertSafeString(value.preset, 'catalog.preset', MAX_PRESET_LENGTH);
  if (expectedPreset !== undefined && preset !== expectedPreset) {
    throw routeCatalogError('ROUTE_CATALOG_SCOPE_MISMATCH', `catalog belongs to preset ${preset}, expected ${expectedPreset}`);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw routeCatalogError('ROUTE_CATALOG_INVALID', 'catalog.revision must be a positive integer');
  }
  const updatedAt = assertSafeString(value.updated_at, 'catalog.updated_at', 80);
  if (!Array.isArray(value.routes) || value.routes.length === 0) {
    throw routeCatalogError('ROUTE_CATALOG_INVALID', 'catalog.routes must be a non-empty array');
  }
  const seen = new Set();
  const routes = value.routes.map((route) => {
    const normalized = normalizeRouteEntry(route);
    if (seen.has(normalized.route_id)) throw routeCatalogError('ROUTE_CATALOG_INVALID', `duplicate route_id ${normalized.route_id}`);
    seen.add(normalized.route_id);
    if (normalized.created_at === undefined || normalized.approval_ref === undefined) {
      throw routeCatalogError('ROUTE_CATALOG_INVALID', `catalog route ${normalized.route_id} lacks provenance metadata`);
    }
    return normalized;
  });
  const catalog = {
    version: ROUTE_CATALOG_VERSION,
    preset,
    revision: value.revision,
    updated_at: updatedAt,
    routes,
  };
  const digest = catalogDigest(catalog);
  if (typeof value.catalog_digest !== 'string' || value.catalog_digest !== digest) {
    throw routeCatalogError('ROUTE_CATALOG_TAMPERED', 'catalog digest does not match its routes');
  }
  catalog.catalog_digest = digest;
  return catalog;
}

export function buildInitialCatalog({ preset, routes, now = new Date().toISOString(), approvalRef = 'bootstrap' }) {
  assertSafeString(preset, 'preset', MAX_PRESET_LENGTH);
  if (!Array.isArray(routes) || routes.length === 0) {
    throw routeCatalogError('ROUTE_CATALOG_INVALID', 'initial routes must be a non-empty array');
  }
  const normalized = routes.map((route) => {
    const policy = normalizeRouteEntry(route);
    return {
      ...policy,
      created_at: assertSafeString(now, 'route.created_at', 80),
      approval_ref: assertSafeString(approvalRef, 'route.approval_ref', 200),
      digest: routeEntryDigest(policy),
    };
  });
  const ids = new Set();
  for (const route of normalized) {
    if (ids.has(route.route_id)) throw routeCatalogError('ROUTE_CATALOG_INVALID', `duplicate route_id ${route.route_id}`);
    ids.add(route.route_id);
  }
  const catalog = {
    version: ROUTE_CATALOG_VERSION,
    preset,
    revision: 1,
    updated_at: now,
    routes: normalized,
  };
  return { ...catalog, catalog_digest: catalogDigest(catalog) };
}

function assertAbsoluteDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir === path.parse(dir).root) {
    throw routeCatalogError('ROUTE_CATALOG_INVALID', 'catalogDir must be an absolute private directory');
  }
  return path.resolve(dir);
}

function assertPrivateDir(dir, missingCode = 'ROUTE_CATALOG_UNAVAILABLE') {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') throw routeCatalogError(missingCode, 'route catalog directory is missing', { dir });
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    throw routeCatalogError('ROUTE_CATALOG_UNAVAILABLE', 'route catalog directory must be a real 0700 directory', { dir });
  }
}

function ensurePrivateDir(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    stat = lstatSync(dir);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw routeCatalogError('ROUTE_CATALOG_UNAVAILABLE', 'route catalog directory must be a real directory', { dir });
  }
  chmodSync(dir, 0o700);
  assertPrivateDir(dir);
}

function assertPrivateFile(file, missingCode) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw routeCatalogError(missingCode, 'route catalog file is missing', { file });
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw routeCatalogError('ROUTE_CATALOG_UNAVAILABLE', 'route catalog file must be a real 0600 file', { file });
  }
}

function atomicWriteJson(file, value, dir) {
  ensurePrivateDir(dir);
  const payload = JSON.stringify(value, null, 2) + '\n';
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeSync(fd, payload, undefined, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, 0o600);
    // Never silently replace a catalog/proposal path that has become a
    // symlink or another unsafe object between validation and commit.
    try {
      const targetStat = lstatSync(file);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()
        || (targetStat.mode & 0o777) !== 0o600) {
        throw routeCatalogError('ROUTE_CATALOG_UNAVAILABLE', 'atomic target is not a private regular file', { file });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

function isPrivateRegularStat(stat, mode = 0o600) {
  return stat?.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === mode;
}

function openNoFollow(file, flags) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  return openSync(file, flags | noFollow);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockRecord(lockPath) {
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!isPrivateRegularStat(stat)) {
    throw routeCatalogError(
      'ROUTE_CATALOG_UNAVAILABLE',
      'catalog lock must be a real private 0600 file',
      { file: lockPath },
    );
  }
  let fd;
  try {
    fd = openNoFollow(lockPath, fsConstants.O_RDONLY);
    const opened = fstatSync(fd);
    if (!isPrivateRegularStat(opened)) {
      throw routeCatalogError(
        'ROUTE_CATALOG_UNAVAILABLE',
        'catalog lock changed to an unsafe file',
        { file: lockPath },
      );
    }
    const raw = readFileSync(fd, 'utf8');
    let value;
    try { value = JSON.parse(raw); } catch {
      throw routeCatalogError('ROUTE_CATALOG_UNAVAILABLE', 'catalog lock is not valid JSON', { file: lockPath });
    }
    if (!isRecord(value) || typeof value.token !== 'string' || value.token.length < 16
      || !Number.isSafeInteger(value.pid) || typeof value.created_at !== 'string'
      || typeof value.expires_at !== 'string') {
      throw routeCatalogError('ROUTE_CATALOG_UNAVAILABLE', 'catalog lock metadata is invalid', { file: lockPath });
    }
    return { value, stat: opened };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function lockIsStale(record, nowMs, staleMs) {
  const created = Date.parse(record.value.created_at);
  const expires = Date.parse(record.value.expires_at);
  const age = Number.isFinite(created) ? nowMs - created : nowMs - record.stat.mtimeMs;
  if (age < staleMs) return false;
  return !processIsAlive(record.value.pid) || !Number.isFinite(expires) || nowMs >= expires;
}

function waitForLock(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function releaseCatalogLock(lock) {
  if (!lock) return;
  const record = readLockRecord(lock.path);
  if (record === null) return;
  if (record.value.token !== lock.token
    || record.stat.ino !== lock.stat.ino
    || record.stat.dev !== lock.stat.dev) {
    throw routeCatalogError('ROUTE_CATALOG_LOCK_LOST', 'catalog lock ownership changed before release');
  }
  unlinkSync(lock.path);
}

function textQuery(value) {
  return typeof value === 'string' ? normalizeAlias(value) : '';
}

function routeMatches(route, query) {
  const raw = typeof query === 'string' ? query : query?.query ?? query?.name ?? '';
  const routeId = typeof query === 'object' && query !== null ? query.route_id : undefined;
  const q = textQuery(raw);
  const provider = typeof query === 'object' && query !== null ? query.provider : undefined;
  const model = typeof query === 'object' && query !== null ? query.model : undefined;
  const effort = typeof query === 'object' && query !== null ? query.reasoningEffort : undefined;
  if (routeId !== undefined && route.route_id !== routeId) return false;
  if (provider !== undefined && route.provider !== provider) return false;
  if (model !== undefined && route.model !== model) return false;
  if (effort !== undefined && route.reasoningEffort !== effort) return false;
  if (routeId !== undefined) return true;
  if (q.length === 0) return provider !== undefined || model !== undefined || effort !== undefined;
  return route.route_id === raw
    || normalizeAlias(route.route_id) === q
    || normalizeAlias(route.provider) === q
    || normalizeAlias(route.model) === q
    || route.aliases.some((alias) => normalizeAlias(alias) === q);
}

function routeWithoutBookkeeping(route) {
  const { created_at: _createdAt, approval_ref: _approvalRef, digest: _digest, ...policy } = route;
  return policy;
}

function safeProposalId(value) {
  if (typeof value !== 'string' || !PROPOSAL_ID_PATTERN.test(value)) {
    throw routeCatalogError('PROPOSAL_INVALID', 'proposal_id is invalid');
  }
  return value;
}

function proposalPolicy(proposal) {
  return {
    version: proposal.version,
    preset: proposal.preset,
    proposal_id: proposal.proposal_id,
    route: proposal.route,
    root_agent_id: proposal.root_agent_id,
    initiator_agent_id: proposal.initiator_agent_id,
    session_id: proposal.session_id,
    proposed_turn: proposal.proposed_turn,
    proposed_seq: proposal.proposed_seq,
    created_at: proposal.created_at,
    expires_at: proposal.expires_at,
    digest: proposal.digest,
    confirmation_phrase: proposal.confirmation_phrase,
  };
}

/**
 * Keep confirmation text single-line while preserving exact values. Simple
 * token values remain human-readable; arrays and values containing whitespace
 * use percent-encoded canonical JSON so copy/paste cannot introduce a line
 * break or a bidi/control character.
 */
function confirmationValue(value) {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  if (/^[A-Za-z0-9._:/+@-]+$/.test(text)) return text;
  return encodeURIComponent(text);
}

function confirmationAliases(route) {
  return encodeURIComponent(canonicalJson(route.aliases ?? []));
}

function confirmationPhrase(proposalId, route, digest) {
  return `CONFIRM ROUTE route_id=${confirmationValue(route.route_id)} provider=${confirmationValue(route.provider)}`
    + ` model=${confirmationValue(route.model)}`
    + ` reasoningEffort=${confirmationValue(route.reasoningEffort ?? 'provider-default')}`
    + ` effort=${confirmationValue(route.reasoningEffort ?? 'provider-default')}`
    + ` maxTokens=${route.maxTokens === undefined ? 'provider-default' : route.maxTokens}`
    + ` aliases=${confirmationAliases(route)}`
    + ` proposal_id=${proposalId} digest=${digest}`;
}

function normalizedRouteIdentity(value) {
  return normalizeAlias(value);
}

function assertRouteIdentityAvailable(catalog, route) {
  const candidateId = normalizedRouteIdentity(route.route_id);
  const existingIds = new Set(catalog.routes.map((entry) => normalizedRouteIdentity(entry.route_id)));
  const existingAliases = new Set(catalog.routes.flatMap((entry) => (
    entry.aliases.map((alias) => normalizedRouteIdentity(alias))
  )));
  if (existingIds.has(candidateId)) {
    throw routeCatalogError('ROUTE_ID_CONFLICT', `route_id ${route.route_id} is already registered`);
  }
  if (existingAliases.has(candidateId)) {
    throw routeCatalogError(
      'ROUTE_ID_CONFLICT',
      `route_id ${route.route_id} conflicts with an existing route alias`,
    );
  }
  const ownAliases = new Set();
  for (const alias of route.aliases ?? []) {
    const normalized = normalizedRouteIdentity(alias);
    if (normalized === candidateId || existingIds.has(normalized)) {
      throw routeCatalogError(
        'ROUTE_ALIAS_CONFLICT',
        `route alias ${alias} conflicts with an existing route_id`,
      );
    }
    if (ownAliases.has(normalized)) {
      throw routeCatalogError('ROUTE_ALIAS_CONFLICT', `route alias ${alias} is duplicated`);
    }
    ownAliases.add(normalized);
  }
}

function validateProposal(value, expectedPreset, expectedId = undefined) {
  const proposal = assertRecord(value, 'route proposal');
  allowedKeys(proposal, new Set([
    'version', 'preset', 'proposal_id', 'route', 'root_agent_id', 'initiator_agent_id',
    'session_id', 'proposed_turn', 'proposed_seq', 'created_at', 'expires_at', 'digest',
    'confirmation_phrase', 'proposal_digest',
  ]), 'route proposal');
  if (proposal.version !== ROUTE_CATALOG_VERSION
    || typeof proposal.preset !== 'string'
    || proposal.preset !== expectedPreset) {
    throw routeCatalogError('PROPOSAL_INVALID', 'proposal version or preset is invalid');
  }
  assertSafeString(proposal.preset, 'proposal.preset', MAX_PRESET_LENGTH);
  const proposalId = safeProposalId(proposal.proposal_id);
  if (expectedId !== undefined && proposalId !== expectedId) throw routeCatalogError('PROPOSAL_INVALID', 'proposal id does not match its filename');
  const routeInput = assertRecord(proposal.route, 'proposal.route');
  allowedKeys(routeInput, ROUTE_POLICY_KEYS, 'proposal.route');
  const route = normalizeRouteEntry(routeInput);
  const stringFields = ['root_agent_id', 'initiator_agent_id', 'session_id', 'created_at', 'expires_at', 'digest', 'confirmation_phrase', 'proposal_digest'];
  for (const field of stringFields) assertSafeString(proposal[field], `proposal.${field}`, 4096);
  if (!Number.isSafeInteger(proposal.proposed_seq) || proposal.proposed_seq < 0) {
    throw routeCatalogError('PROPOSAL_INVALID', 'proposal.proposed_seq is invalid');
  }
  if (!(proposal.proposed_turn === null || Number.isSafeInteger(proposal.proposed_turn) && proposal.proposed_turn >= 0)) {
    throw routeCatalogError('PROPOSAL_INVALID', 'proposal.proposed_turn is invalid');
  }
  const digest = routeEntryDigest(route);
  if (proposal.digest !== digest || proposal.confirmation_phrase !== confirmationPhrase(proposalId, route, digest)) {
    throw routeCatalogError('PROPOSAL_TAMPERED', 'proposal route digest or confirmation phrase does not match');
  }
  if (proposal.proposal_digest !== sha256(proposalPolicy({ ...proposal, route: routeWithoutBookkeeping(route) }))) {
    throw routeCatalogError('PROPOSAL_TAMPERED', 'proposal digest does not match its authorization binding');
  }
  return {
    ...proposal,
    route: routeWithoutBookkeeping(route),
  };
}

/** Private, per-preset catalog plus one-time proposal store. */
export class RouteCatalogStore {
  constructor(catalogDir, options = {}) {
    this.catalogDir = assertAbsoluteDir(catalogDir);
    this.preset = assertSafeString(options.preset ?? 'gzh-studio', 'preset', MAX_PRESET_LENGTH);
    this.proposalTtlMs = Number.isSafeInteger(options.proposalTtlMs)
      && options.proposalTtlMs > 0 ? options.proposalTtlMs : DEFAULT_PROPOSAL_TTL_MS;
    this.lockWaitMs = Number.isSafeInteger(options.lockWaitMs)
      && options.lockWaitMs >= 0 ? options.lockWaitMs : DEFAULT_CATALOG_LOCK_WAIT_MS;
    this.lockStaleMs = Number.isSafeInteger(options.lockStaleMs)
      && options.lockStaleMs > 0 ? options.lockStaleMs : DEFAULT_CATALOG_LOCK_STALE_MS;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._writeQueue = Promise.resolve();
  }

  ensureDirectory() {
    ensurePrivateDir(this.catalogDir);
    return this.catalogDir;
  }

  catalogPath() {
    return path.join(this.catalogDir, 'catalog.json');
  }

  proposalPath(proposalId) {
    return path.join(this.catalogDir, `proposal-${safeProposalId(proposalId)}.json`);
  }

  assertReady() {
    this.ensureDirectory();
    const file = this.catalogPath();
    assertPrivateFile(file, 'ROUTE_CATALOG_UNAVAILABLE');
    return file;
  }

  readCatalog() {
    const file = this.assertReady();
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw routeCatalogError('ROUTE_CATALOG_INVALID', 'catalog.json is not valid JSON', { cause: error });
    }
    return deepFreeze(cloneJson(makeCatalog(parsed, this.preset)));
  }

  listRoutes() {
    return this.readCatalog().routes.map((route) => deepFreeze(cloneJson(route)));
  }

  getRoute(routeId) {
    const routes = this.readCatalog().routes;
    return routes.find((route) => route.route_id === routeId);
  }

  resolve(query) {
    const catalog = this.readCatalog();
    const candidates = catalog.routes.filter((route) => routeMatches(route, query));
    return {
      query: typeof query === 'string' ? query : cloneJson(query),
      status: candidates.length === 1 ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'unmatched',
      candidates: candidates.map((route) => deepFreeze(cloneJson(route))),
      catalog_revision: catalog.revision,
      catalog_digest: catalog.catalog_digest,
    };
  }

  createProposal(input) {
    const value = assertRecord(input, 'proposal input');
    allowedKeys(value, new Set([
      'route', 'root_agent_id', 'initiator_agent_id', 'session_id',
      'proposed_turn', 'proposed_seq',
    ]), 'proposal input');
    const routeInput = assertRecord(value.route, 'proposal.route');
    allowedKeys(routeInput, ROUTE_POLICY_KEYS, 'proposal.route');
    const route = normalizeRouteEntry(routeInput);
    for (const field of ['root_agent_id', 'initiator_agent_id', 'session_id']) {
      assertSafeString(value[field], `proposal ${field}`, 512);
    }
    if (!(value.proposed_turn === null || Number.isSafeInteger(value.proposed_turn) && value.proposed_turn >= 0)) {
      throw routeCatalogError('PROPOSAL_INVALID', 'proposal proposed_turn is invalid');
    }
    if (!Number.isSafeInteger(value.proposed_seq) || value.proposed_seq < 0) {
      throw routeCatalogError('PROPOSAL_INVALID', 'proposal proposed_seq is invalid');
    }
    this.ensureDirectory();
    const currentCatalog = this.readCatalog();
    assertRouteIdentityAvailable(currentCatalog, route);
    const nowMs = this.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.proposalTtlMs).toISOString();
    const digest = routeEntryDigest(route);
    let proposalId;
    let file;
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidateId = randomBytes(18).toString('base64url');
      const candidateFile = this.proposalPath(candidateId);
      try {
        lstatSync(candidateFile);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        proposalId = candidateId;
        file = candidateFile;
        break;
      }
    }
    if (!proposalId || !file) throw routeCatalogError('PROPOSAL_WRITE_FAILED', 'unable to allocate proposal id');
    const proposal = {
      version: ROUTE_CATALOG_VERSION,
      preset: this.preset,
      proposal_id: proposalId,
      route: routeWithoutBookkeeping(route),
      root_agent_id: value.root_agent_id,
      initiator_agent_id: value.initiator_agent_id,
      session_id: value.session_id,
      proposed_turn: value.proposed_turn,
      proposed_seq: value.proposed_seq,
      created_at: createdAt,
      expires_at: expiresAt,
      digest,
      confirmation_phrase: confirmationPhrase(proposalId, route, digest),
    };
    proposal.proposal_digest = sha256(proposalPolicy(proposal));
    atomicWriteJson(file, proposal, this.catalogDir);
    return deepFreeze(cloneJson(proposal));
  }

  readProposal(proposalId) {
    const file = this.proposalPath(proposalId);
    assertPrivateFile(file, 'PROPOSAL_NOT_FOUND');
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw routeCatalogError('PROPOSAL_INVALID', 'proposal is not valid JSON', { cause: error });
    }
    return deepFreeze(cloneJson(validateProposal(parsed, this.preset, proposalId)));
  }

  isExpired(proposal, nowMs = this.now()) {
    const expires = Date.parse(proposal.expires_at);
    return !Number.isFinite(expires) || nowMs >= expires;
  }

  removeProposal(proposalId) {
    const file = this.proposalPath(proposalId);
    try {
      assertPrivateFile(file, 'PROPOSAL_NOT_FOUND');
      unlinkSync(file);
    } catch (error) {
      if (error?.code !== 'PROPOSAL_NOT_FOUND') throw error;
    }
  }

  _enqueue(operation) {
    const run = this._writeQueue.then(operation, operation);
    this._writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _acquireCatalogLock() {
    this.ensureDirectory();
    const lockPath = path.join(this.catalogDir, CATALOG_LOCK_FILE);
    const token = randomBytes(18).toString('base64url');
    const startedAt = Date.now();
    const deadline = startedAt + this.lockWaitMs;
    while (true) {
      let fd;
      let created = false;
      try {
        fd = openSync(lockPath, 'wx', 0o600);
        created = true;
        const opened = fstatSync(fd);
        if (!isPrivateRegularStat(opened)) {
          throw routeCatalogError('ROUTE_CATALOG_UNAVAILABLE', 'catalog lock target is unsafe', { file: lockPath });
        }
        const nowMs = Date.now();
        const record = {
          version: 1,
          token,
          pid: process.pid,
          created_at: new Date(nowMs).toISOString(),
          expires_at: new Date(nowMs + this.lockStaleMs).toISOString(),
        };
        writeSync(fd, JSON.stringify(record) + '\n', undefined, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        chmodSync(lockPath, 0o600);
        const checked = readLockRecord(lockPath);
        if (checked === null || checked.value.token !== token) {
          throw routeCatalogError('ROUTE_CATALOG_LOCK_LOST', 'catalog lock changed during acquisition');
        }
        return { path: lockPath, token, stat: checked.stat };
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch {}
        }
        if (error?.code !== 'EEXIST') {
          // A failed first write owns the path only when this attempt created
          // it. Unlinking by path never follows a symlink.
          if (created) {
            try { unlinkSync(lockPath); } catch {}
          }
          throw error;
        }
        let record;
        try {
          record = readLockRecord(lockPath);
        } catch (lockError) {
          // Another process can be between O_EXCL creation and its first
          // fsync. Treat a fresh incomplete lock as busy; an old malformed
          // lock remains a fail-closed unavailable state.
          if (lockError?.code === 'ROUTE_CATALOG_UNAVAILABLE' && Date.now() < deadline) {
            await waitForLock(Math.min(25, Math.max(1, deadline - Date.now())));
            continue;
          }
          throw lockError;
        }
        if (record && lockIsStale(record, Date.now(), this.lockStaleMs)) {
          // Recheck inode/token immediately before unlinking. unlink never
          // follows a symlink, and readLockRecord rejects one explicitly.
          const current = readLockRecord(lockPath);
          if (current && current.value.token === record.value.token
            && current.stat.ino === record.stat.ino && current.stat.dev === record.stat.dev) {
            try { unlinkSync(lockPath); } catch (unlinkError) {
              if (unlinkError?.code !== 'ENOENT') throw unlinkError;
            }
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw routeCatalogError('ROUTE_CATALOG_BUSY', 'route catalog lock wait timed out', { file: lockPath });
        }
        await waitForLock(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
  }

  _assertCatalogCas(expected, actual) {
    if (expected.revision !== actual.revision || expected.catalog_digest !== actual.catalog_digest) {
      throw routeCatalogError(
        'ROUTE_CATALOG_CONFLICT',
        'route catalog changed while the confirmation was being committed',
        {
          expected: {
            revision: expected.revision,
            catalog_digest: expected.catalog_digest,
          },
          actual: {
            revision: actual.revision,
            catalog_digest: actual.catalog_digest,
          },
        },
      );
    }
  }

  /** The only runtime operation that may add an entry to catalog.json. */
  confirmProposal(input) {
    const value = assertRecord(input, 'confirmation input');
    allowedKeys(value, new Set([
      'proposal_id', 'confirmation_phrase',
      'root_agent_id', 'initiator_agent_id', 'session_id',
    ]), 'confirmation input');
    assertSafeString(value.confirmation_phrase, 'confirmation_phrase', 4096);
    return this._enqueue(async () => {
      const lock = await this._acquireCatalogLock();
      try {
        // The lock deliberately starts before proposal read/validation so a
        // second process cannot consume or validate the same proposal against
        // a catalog revision that is about to change.
        const proposal = this.readProposal(value.proposal_id);
        if (value.confirmation_phrase !== proposal.confirmation_phrase) {
          throw routeCatalogError('PROPOSAL_CONFIRMATION_MISMATCH', 'confirmation phrase must exactly match the displayed phrase');
        }
        if (this.isExpired(proposal)) throw routeCatalogError('PROPOSAL_EXPIRED', 'route proposal has expired');
        for (const field of ['root_agent_id', 'initiator_agent_id', 'session_id']) {
          if (value[field] !== proposal[field]) {
            throw routeCatalogError('PROPOSAL_AUTHORITY_MISMATCH', `confirmation ${field} does not match proposal`);
          }
        }
        const catalogFile = this.assertReady();
        const catalog = this.readCatalog();
        const existing = catalog.routes.find((route) => route.route_id === proposal.route.route_id);
        if (existing !== undefined) {
          if (routeEntryDigest(existing) !== proposal.digest) {
            throw routeCatalogError('ROUTE_ID_CONFLICT', `route_id ${proposal.route.route_id} already names another route`);
          }
          this.removeProposal(proposal.proposal_id);
          return { committed: false, already_present: true, route: existing, catalog_digest: catalog.catalog_digest };
        }
        assertRouteIdentityAvailable(catalog, proposal.route);

        // A second catalog read is the compare-and-swap guard. The file lock
        // serializes cooperating processes; CAS still fails closed if an
        // external writer changed the file without taking the lock.
        const currentCatalog = this.readCatalog();
        this._assertCatalogCas(catalog, currentCatalog);
        const createdAt = new Date(this.now()).toISOString();
        const route = {
          ...proposal.route,
          created_at: createdAt,
          approval_ref: `proposal:${proposal.proposal_id}`,
          digest: proposal.digest,
        };
        const nextCatalog = {
          version: catalog.version,
          preset: catalog.preset,
          revision: catalog.revision + 1,
          updated_at: createdAt,
          routes: [...catalog.routes, route],
        };
        const committedCatalog = { ...nextCatalog, catalog_digest: catalogDigest(nextCatalog) };
        atomicWriteJson(catalogFile, committedCatalog, this.catalogDir);
        try {
          this.removeProposal(proposal.proposal_id);
        } catch (error) {
          // Never restore an old catalog over a different successful commit.
          // This check is also the guard against an uncooperative external
          // writer that ignored the lock protocol.
          try {
            const current = this.readCatalog();
            this._assertCatalogCas(committedCatalog, current);
            atomicWriteJson(catalogFile, catalog, this.catalogDir);
          } catch (rollbackError) {
            error.rollbackError = rollbackError;
          }
          throw error;
        }
        return {
          committed: true,
          already_present: false,
          route: deepFreeze(cloneJson(route)),
          catalog_digest: committedCatalog.catalog_digest,
        };
      } finally {
        releaseCatalogLock(lock);
      }
    });
  }
}

/** Deployment/bootstrap helper. Runtime plugin code never calls this function. */
export function initializeRouteCatalog(catalogDir, options) {
  const store = new RouteCatalogStore(catalogDir, { preset: options?.preset ?? 'gzh-studio' });
  store.ensureDirectory();
  const file = store.catalogPath();
  try {
    lstatSync(file);
    throw routeCatalogError('ROUTE_CATALOG_EXISTS', 'catalog.json already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const catalog = buildInitialCatalog({
    preset: store.preset,
    routes: options?.routes,
    now: options?.now,
    approvalRef: options?.approvalRef ?? 'bootstrap',
  });
  atomicWriteJson(file, catalog, store.catalogDir);
  return deepFreeze(cloneJson(catalog));
}

export function routeConfirmationPhrase(proposalId, route, digest = routeEntryDigest(route)) {
  const normalized = normalizeRouteEntry(route);
  const expectedDigest = routeEntryDigest(normalized);
  if (digest !== expectedDigest) {
    throw routeCatalogError('PROPOSAL_TAMPERED', 'confirmation digest does not match the route policy');
  }
  return confirmationPhrase(safeProposalId(proposalId), normalized, expectedDigest);
}
