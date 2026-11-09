// Operator probe for the DSH interface: run it before installing the plugin.
// It reads the same Bridge UI API the plugin's Host half reads and prints what the
// page would show, so a failure is diagnosed without touching the DSH profile.
//
//   node tests/support/dsh-ui-verify.ts [baseUrl]
//
// Required: MNEMOWEAVE_BRIDGE_UI_TOKEN (>=24 chars). Optional: MNEMOWEAVE_BRIDGE_UI_PORT,
// MNEMOWEAVE_BRIDGE_HOST_ID.
import { BridgeUiClient } from '../../plugins/dsh-mnemo-weave/src/ui/bridge-client.ts';

const token = process.env.MNEMOWEAVE_BRIDGE_UI_TOKEN;
if (token === undefined || token.length < 24) {
  process.stdout.write(`${JSON.stringify({ status: 'blocked', reason: 'MNEMOWEAVE_BRIDGE_UI_TOKEN missing or shorter than 24 characters' }, null, 2)}\n`);
  process.exit(1);
}
const port = process.env.MNEMOWEAVE_BRIDGE_UI_PORT ?? '4319';
const baseUrl = process.argv[2] ?? process.env.MNEMOWEAVE_BRIDGE_UI_URL ?? `http://127.0.0.1:${port}`;
const hostId = process.env.MNEMOWEAVE_BRIDGE_HOST_ID;
const client = new BridgeUiClient({ baseUrl, token, ...(hostId === undefined ? {} : { hostId }) });

try {
  const status = await client.status();
  const list = await client.memories({ limit: 5 });
  const intents = await client.intents();
  const first = list.items[0];
  const detail = first === undefined ? undefined : await client.memory(first.memoryId);
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    bridgeUrl: baseUrl,
    paired: status.paired,
    grant: status.grant === null ? null : { projects: status.grant.projects, globalIncluded: status.grant.globalIncluded, expiresAt: status.grant.expiresAt, expired: status.grant.expired, revoked: status.grant.revoked },
    replica: status.replica,
    memories: { availability: list.status, reason: list.reason ?? null, total: list.total, complete: list.complete, sample: first?.excerpt ?? null },
    detail: detail === undefined ? null : { availability: detail.status, revisions: detail.revisions.length, relations: detail.relations.length, contentLength: detail.content?.length ?? 0 },
    intents: { queued: intents.queued, isolated: intents.isolated },
    nextStep: status.paired ? 'Build scripts/build-plugins.mjs, import dist/plugins/dsh-mnemo-weave, and confirm the sidebar page.' : 'Pair the Bridge with the Server before judging the page (status explains why reads are closed).',
  }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'failed', bridgeUrl: baseUrl, message: String(error instanceof Error ? error.message : error).slice(0, 300) }, null, 2)}\n`);
  process.exit(1);
}
