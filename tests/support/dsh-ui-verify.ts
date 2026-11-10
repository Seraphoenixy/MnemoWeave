// Pre-install probe for the DSH memory page: reads the Server exactly the way the plugin does.
//   node tests/support/dsh-ui-verify.ts [serverUrl]
// Requires MNEMOWEAVE_TOKEN (>=24 chars) and MNEMOWEAVE_HOST_ID in the environment.
import { MemoryClient } from '../../packages/client/src/index.ts';

const token = process.env.MNEMOWEAVE_TOKEN;
const hostId = process.env.MNEMOWEAVE_HOST_ID ?? 'dsh-host';
if (!token || token.length < 24) {
  process.stdout.write(`${JSON.stringify({ status: 'blocked', reason: 'MNEMOWEAVE_TOKEN missing or shorter than 24 characters' }, null, 2)}\n`);
  process.exit(1);
}
const baseUrl = process.argv[2] ?? process.env.MNEMOWEAVE_SERVER ?? 'http://127.0.0.1:4317';
const client = new MemoryClient({ baseUrl, token, hostId });

const health = await client.health();
if (!health.ok) {
  process.stdout.write(`${JSON.stringify({ status: 'blocked', reason: `health failed: ${health.error.code}`, baseUrl }, null, 2)}\n`);
  process.exit(1);
}
const list = await client.listMemories({ limit: 5 });
const sample = list.ok && list.value.items.length > 0
  ? await client.readMemory(list.value.items[0]!.memoryId).then(result => result.ok ? { memoryId: list.value.items[0]!.memoryId, ok: true } : { memoryId: list.value.items[0]!.memoryId, ok: false, code: result.error.code })
  : undefined;
process.stdout.write(`${JSON.stringify({
  status: 'ok',
  baseUrl,
  hostId,
  provider: health.value,
  memories: list.ok ? { count: list.value.items.length, items: list.value.items.map(item => ({ memoryId: item.memoryId, scope: item.scope, publishedAt: item.publishedAt })) } : { error: list.error.code },
  sample,
}, null, 2)}\n`);
