import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SyncStore } from '../../../packages/infrastructure/sync-store/src/index.ts';
import { SyncStream } from '../../../packages/core/contracts/src/index.ts';
import type { SyncStreamGrantValue } from '../../../packages/core/contracts/src/index.ts';

/**
 * Device administration for the remote sync Server. Tokens are generated here,
 * printed once, and stored hashed; there is no management UI in the first version.
 *
 *   node enroll.js enroll <deviceId> <stream>:<r|w|rw> [more streams...]
 *   node enroll.js revoke <deviceId>
 *
 * A stream is `rules`, `formal-memories` or `workspace-archives:<workspaceId>`. The granted
 * stream is exactly the stream the remote will derive from an entry, so a device that holds only
 * a workspace stream cannot submit or read a formal memory.
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

function parseGrant(spec: string): SyncStreamGrantValue {
  // A workspace stream itself contains a colon, so the mode is the trailing segment.
  const match = /^(.+):(r|w|rw)$/.exec(spec);
  if (!match) fail(`INVALID_GRANT:${spec}`);
  const [, stream, mode] = match as unknown as [string, string, 'r' | 'w' | 'rw'];
  const grant = { stream, canRead: mode === 'r' || mode === 'rw', canWrite: mode === 'w' || mode === 'rw' };
  const parsed = SyncStream.safeParse(stream);
  if (!parsed.success) fail(`INVALID_STREAM:${stream}`);
  return grant;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'enroll') {
  const [deviceId, ...specs] = args;
  if (!deviceId) fail('USAGE:enroll <deviceId> <stream>:<r|w|rw> ...');
  if (specs.length === 0) fail('USAGE:enroll <deviceId> <stream>:<r|w|rw> ...');
  const grants = specs.map(parseGrant);
  const token = randomBytes(32).toString('base64url');
  const store = openStore();
  try {
    store.enroll(deviceId, token, grants);
  } finally {
    store.close();
  }
  process.stdout.write(`${JSON.stringify({ deviceId, token, streams: grants }, null, 2)}\n`);
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
  fail('USAGE:enroll <deviceId> <stream>:<r|w|rw> ... | revoke <deviceId>');
}
