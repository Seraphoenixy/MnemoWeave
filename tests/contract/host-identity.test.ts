import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOST_ID as CHATGPT_HOST } from '../../packages/adapters/chatgpt/src/index.ts';
import { DEFAULT_HOST_ID as ZCODE_HOST } from '../../packages/adapters/zcode/src/index.ts';

/**
 * Each host adapter names itself; there is no single correct machine-wide identity.
 *
 * An earlier design left MNEMOWEAVE_HOST_ID as a user environment variable set to `dsh`, which
 * made both ZCode and the ChatGPT app report themselves as DSH. Injection records, per-host
 * reads and attribution all depend on this value being right, so each adapter carries its own
 * default and only an explicit per-process override may change it.
 */

test('each adapter declares a distinct Host identity', () => {
  assert.equal(CHATGPT_HOST, 'chatgpt-desktop');
  assert.equal(ZCODE_HOST, 'zcode');
  assert.notEqual(CHATGPT_HOST, ZCODE_HOST, 'two hosts must never share an identity');
  assert.notEqual(ZCODE_HOST, 'dsh', 'an adapter must not claim another host\'s identity');
  assert.notEqual(CHATGPT_HOST, 'dsh', 'an adapter must not claim another host\'s identity');
});

test('the common identity values are stable, so stored host rows stay readable', () => {
  // These strings appear in runtime_injections rows and in Host headers the Server groups by.
  // Changing one silently orphans that host's history, so pin them.
  for (const value of [CHATGPT_HOST, ZCODE_HOST]) {
    assert.match(value, /^[a-z][a-z0-9-]{1,40}$/, `${value} must be a lowercase identifier`);
  }
});
