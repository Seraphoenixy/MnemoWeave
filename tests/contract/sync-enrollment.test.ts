import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import * as srp from 'secure-remote-password/client.js';
import { createEnrollment } from '../../apps/sync-server/src/enrollment.ts';
import { acquireSyncCredential } from '../../packages/infrastructure/sync-client/src/enrollment.ts';
import { SyncStore } from '../../packages/infrastructure/sync-store/src/index.ts';
import { createSyncServer } from '../../packages/protocols/sync-http/src/index.ts';
import { tempDir } from '../support/temp.ts';

test('bootstrap, SRP login, and one-time pairing issue persistent library credentials', async () => {
  const path = join(await tempDir('sync-enrollment', 'remote'), 'sync.db');
  const store = new SyncStore({ path });
  const bootstrapToken = 'b'.repeat(40);
  const server = createSyncServer({
    gateway: store, enrollment: createEnrollment(store, bootstrapToken),
    enrollmentSource: request => request.headers['x-test-source']?.toString() ?? 'legitimate',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = 'http://127.0.0.1:' + address.port;
  const options = { baseUrl, label: 'device', secret: 'test password' };
  try {
    await assert.rejects(acquireSyncCredential({ ...options, mode: 'initialize', bootstrapToken: 'wrong' }), /401/);
    const first = await acquireSyncCredential({ ...options, mode: 'initialize', bootstrapToken, label: 'first' });
    const clientPublicEphemeral = srp.generateEphemeral().public;
    const challenge = () => fetch(baseUrl + '/v1/sync/auth/login/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-source': 'limited' },
      body: JSON.stringify({ clientPublicEphemeral }),
    });
    for (let index = 0; index < 10; index++) {
      const result = await challenge();
      assert.equal(result.status, 200);
      await result.json();
    }
    assert.equal((await challenge()).status, 401);
    await assert.rejects(acquireSyncCredential({ ...options, mode: 'login', secret: 'wrong password' }), /401/);
    const second = await acquireSyncCredential({ ...options, mode: 'login', label: 'second' });
    assert.notEqual(first.deviceId, second.deviceId);
    const response = await fetch(baseUrl + '/v1/sync/devices/pairing-token', {
      method: 'POST', headers: { authorization: 'Bearer ' + first.token },
    });
    assert.equal(response.status, 200);
    const { pairingToken } = await response.json() as { pairingToken: string };
    const paired = await acquireSyncCredential({ ...options, mode: 'pair', secret: pairingToken, label: 'paired' });
    await assert.rejects(acquireSyncCredential({ ...options, mode: 'pair', secret: pairingToken }), /401/);
    const reopened = new SyncStore({ path });
    try {
      assert.equal(reopened.streams(paired.token).deviceId, paired.deviceId);
      assert.deepEqual(Object.fromEntries(reopened.devices().map(device => [device['deviceId'], device['label']])), {
        [first.deviceId]: 'first', [second.deviceId]: 'second', [paired.deviceId]: 'paired',
      });
      assert.equal(reopened.revoke(paired.deviceId), true);
      assert.equal(reopened.revoke('unknown'), false);
      assert.throws(() => reopened.streams(paired.token), { code: 'DEVICE_REVOKED' });
    } finally {
      reopened.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
