import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SyncStore } from '../../../packages/infrastructure/sync-store/src/index.ts';
import type { SyncScopeGrantValue } from '../../../packages/core/contracts/src/index.ts';

/**
 * Device administration for the remote sync Server. Tokens are generated here,
 * printed once, and stored hashed; there is no management UI in the first version.
 *
 *   node enroll.js enroll <deviceId> <scope>:<r|w|rw> [more scopes...]
 *   node enroll.js revoke <deviceId>
 */

function fail(message: string): never {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function openStore(): SyncStore {
  const stateDir = process.env['MNEMOWEAVE_SYNC_STATE_DIR']?.trim();
  if (!stateDir) fail('CONFIG_MISSING:MNEMOWEAVE_SYNC_STATE_DIR');
  return new SyncStore({ path: join(stateDir, 'sync.db') });
}

function parseGrant(spec: string): SyncScopeGrantValue {
  const match = /^(.+):(r|w|rw)$/.exec(spec);
  if (!match) fail(`INVALID_GRANT:${spec}`);
  const [, scope, mode] = match as unknown as [string, string, 'r' | 'w' | 'rw'];
  return { scope, canRead: mode === 'r' || mode === 'rw', canWrite: mode === 'w' || mode === 'rw' };
}

const [command, ...args] = process.argv.slice(2);
if (command === 'enroll') {
  const [deviceId, ...specs] = args;
  if (!deviceId) fail('USAGE:enroll <deviceId> <scope>:<r|w|rw> ...');
  if (specs.length === 0) fail('USAGE:enroll <deviceId> <scope>:<r|w|rw> ...');
  const grants = specs.map(parseGrant);
  const token = randomBytes(32).toString('base64url');
  const store = openStore();
  try {
    store.enroll(deviceId, token, grants);
  } finally {
    store.close();
  }
  process.stdout.write(`${JSON.stringify({ deviceId, token, scopes: grants }, null, 2)}\n`);
} else if (command === 'revoke') {
  const [deviceId] = args;
  if (!deviceId) fail('USAGE:revoke <deviceId>');
  const store = openStore();
  try {
    store.revoke(deviceId);
  } finally {
    store.close();
  }
  process.stdout.write(`${JSON.stringify({ deviceId, revoked: true })}\n`);
} else {
  fail('USAGE:enroll <deviceId> <scope>:<r|w|rw> ... | revoke <deviceId>');
}
