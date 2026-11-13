import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SyncStore } from '../../../packages/infrastructure/sync-store/src/index.ts';
import { LegacyWorkspaceMap } from '../../../packages/core/contracts/src/index.ts';

/** Local administration of remote sync devices. */
function fail(message: string): never {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function openStore(): SyncStore {
  const stateDir = process.env['MNEMOWEAVE_SYNC_STATE_DIR']?.trim();
  if (!stateDir) fail('CONFIG_MISSING:MNEMOWEAVE_SYNC_STATE_DIR');
  const mapPath = process.env['MNEMOWEAVE_LEGACY_WORKSPACE_MAP'];
  return new SyncStore({
    path: join(stateDir, 'sync.db'),
    ...(mapPath ? { legacyWorkspaces: LegacyWorkspaceMap.parse(JSON.parse(readFileSync(mapPath, 'utf8'))) } : {}),
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === 'enroll') {
  const [deviceId, ...specs] = args;
  if (!deviceId || specs.length > 0) fail('USAGE:enroll <deviceId>');
  const token = randomBytes(32).toString('base64url');
  const store = openStore();
  try {
    store.enroll(deviceId, token);
  } finally {
    store.close();
  }
  process.stdout.write(`${JSON.stringify({ deviceId, token }, null, 2)}\n`);
} else if (command === 'list' && args.length === 0) {
  const store = openStore();
  try {
    process.stdout.write(JSON.stringify(store.devices(), null, 2) + '\n');
  } finally {
    store.close();
  }
} else if (command === 'revoke') {
  const [deviceId] = args;
  if (!deviceId) fail('USAGE:revoke <deviceId>');
  const store = openStore();
  let revoked: boolean;
  try {
    revoked = store.revoke(deviceId);
  } finally {
    store.close();
  }
  if (!revoked) fail('DEVICE_NOT_FOUND');
  process.stdout.write(`${JSON.stringify({ deviceId, revoked: true })}\n`);
} else {
  fail('USAGE:enroll <deviceId> | list | revoke <deviceId>');
}
