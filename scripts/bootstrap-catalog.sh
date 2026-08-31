#!/bin/sh

set -eu
umask 077

usage() {
  printf '%s\n' 'Usage: sh scripts/bootstrap-catalog.sh [--dry-run]' >&2
}

DRY_RUN=0
case "${1-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  usage
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'bootstrap-catalog: node is required' >&2
  exit 1
fi

if [ -n "${DSH_HOME:-}" ]; then
  BOOTSTRAP_DSH_HOME=$DSH_HOME
elif [ -n "${HOME:-}" ]; then
  BOOTSTRAP_DSH_HOME=$HOME/.dsh
else
  printf '%s\n' 'bootstrap-catalog: DSH_HOME or HOME must be set' >&2
  exit 1
fi

exec node - "$BOOTSTRAP_DSH_HOME" "$DRY_RUN" <<'NODE'
const { createHash } = require('node:crypto');
const {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} = require('node:fs');
const path = require('node:path');

const rawHome = process.argv[2];
const dryRun = process.argv[3] === '1';

function fail(message) {
  throw new Error(message);
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function privateDirectory(directory, create) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    if (!isMissing(error) || !create) throw error;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    stat = lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`catalog path is not a real directory: ${directory}`);
  }
  if (create) chmodSync(directory, 0o700);
  stat = lstatSync(directory);
  if ((stat.mode & 0o777) !== 0o700) {
    fail(`catalog directory is not mode 0700: ${directory}`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('catalog digest cannot encode this number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') fail('catalog digest cannot encode this value');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function catalogDigest(catalog) {
  const policy = {
    version: catalog.version,
    preset: catalog.preset,
    revision: catalog.revision,
    routes: catalog.routes,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(policy), 'utf8').digest('hex')}`;
}

function readCatalog(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`catalog.json is not a real file: ${file}`);
  if ((stat.mode & 0o777) !== 0o600) fail(`catalog.json is not mode 0600: ${file}`);

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`catalog.json is not valid JSON: ${error.message}`);
  }
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) fail('catalog.json must contain an object');
  if (catalog.version !== 1) fail(`unsupported catalog version: ${String(catalog.version)}`);
  if (catalog.preset !== 'shared') fail(`catalog preset must be shared: ${String(catalog.preset)}`);
  if (!Number.isSafeInteger(catalog.revision) || catalog.revision < 1) fail('catalog revision must be a positive integer');
  if (typeof catalog.updated_at !== 'string' || catalog.updated_at.length === 0) fail('catalog updated_at must be a non-empty string');
  if (!Array.isArray(catalog.routes)) fail('catalog routes must be an array');
  if (typeof catalog.catalog_digest !== 'string' || catalog.catalog_digest !== catalogDigest(catalog)) {
    fail('catalog_digest does not match catalog contents');
  }
  return catalog;
}

function writeInitialCatalog(file, directory) {
  const catalog = {
    version: 1,
    preset: 'shared',
    revision: 1,
    updated_at: new Date().toISOString(),
    routes: [],
  };
  const payload = `${JSON.stringify({ ...catalog, catalog_digest: catalogDigest(catalog) }, null, 2)}\n`;
  const temporary = path.join(directory, `.catalog.json.${process.pid}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeSync(fd, payload, undefined, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    try {
      lstatSync(file);
      fail('catalog.json appeared during bootstrap; refusing to overwrite it');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  return catalog;
}

try {
  if (typeof rawHome !== 'string' || rawHome.length === 0) fail('DSH_HOME resolved to an empty path');
  const home = path.resolve(rawHome);
  if (!path.isAbsolute(home) || home === path.parse(home).root) fail('DSH_HOME must resolve to a non-root absolute path');

  const routeCatalog = path.join(home, 'route-catalog');
  const shared = path.join(routeCatalog, 'shared');
  const bindings = path.join(shared, 'bindings');
  const snapshots = path.join(shared, 'snapshots');
  const catalogFile = path.join(shared, 'catalog.json');

  if (dryRun) {
    console.log('bootstrap-catalog: dry-run (no filesystem changes)');
    console.log(`[dry-run] normalized DSH_HOME: ${home}`);
    console.log(`[dry-run] ensure 0700 directory: ${routeCatalog}`);
    console.log(`[dry-run] ensure 0700 directory: ${shared}`);
    console.log(`[dry-run] ensure 0700 directory: ${bindings}`);
    console.log(`[dry-run] ensure 0700 directory: ${snapshots}`);
    console.log(`[dry-run] create 0600 catalog.json if absent: ${catalogFile}`);
    console.log(`[dry-run] validate existing catalog.json without overwrite: ${catalogFile}`);
    process.exit(0);
  }

  privateDirectory(routeCatalog, true);
  privateDirectory(shared, true);
  privateDirectory(bindings, true);
  privateDirectory(snapshots, true);

  const existing = readCatalog(catalogFile);
  if (existing) {
    console.log(`bootstrap-catalog: existing catalog validated (not overwritten): ${catalogFile}`);
  } else {
    writeInitialCatalog(catalogFile, shared);
    console.log(`bootstrap-catalog: created mode 0600 catalog: ${catalogFile}`);
  }
  console.log(`bootstrap-catalog: ready at ${shared}`);
} catch (error) {
  console.error(`bootstrap-catalog: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
NODE
