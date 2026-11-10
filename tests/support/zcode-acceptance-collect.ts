// ZCode acceptance evidence collector (user-facing): run AFTER a real desktop session.
//   node dist/tests/support/zcode-acceptance-collect.js <stateDir> [hostId]
// Reads session_events from the governance store, maps the captured hooks onto the
// HOST-03 event categories, and emits the sanitized result block to paste into
// docs/host-acceptance.md.
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join } from 'node:path';

const stateDir = process.argv[2];
const hostId = process.argv[3] ?? 'zcode-host';
if (!stateDir || !isAbsolute(stateDir)) {
  process.stderr.write('usage: zcode-acceptance-collect <absoluteStateDir> [hostId]\n');
  process.exit(2);
}
const dbPath = join(stateDir, 'governance.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const rows = db.prepare('SELECT event_id, kind, received_at, payload_json FROM session_events WHERE host_id=? ORDER BY received_at').all(hostId) as { event_id: string; kind: string; received_at: string; payload_json: string }[];
  const categories: Record<string, { count: number; first: string; sample: string }> = {};
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const entry = categories[row.kind] ?? { count: 0, first: row.received_at, sample: '' };
    entry.count++;
    if (!entry.sample) {
      entry.sample = JSON.stringify({ ...payload, text: typeof payload['text'] === 'string' ? `${(payload['text'] as string).slice(0, 80)}…` : payload['text'], tool_response: undefined }, null, 0).slice(0, 200);
    }
    categories[row.kind] = entry;
  }
  const required = ['session.started', 'message.user', 'tool.completed', 'message.assistant.final', 'session.ended'];
  const covered = required.filter(kind => kind in categories);
  const sanitized = rows.map(row => ({
    eventId: `${row.event_id.slice(0, 8)}…`,
    kind: row.kind,
    receivedAt: row.received_at,
    payloadKeys: Object.keys(JSON.parse(row.payload_json) as Record<string, unknown>),
  }));
  process.stdout.write(`${JSON.stringify({
    hostId,
    stateDir,
    totalEvents: rows.length,
    categories,
    host03Coverage: `${covered.length}/6 categories observed${covered.length ? `: ${covered.join(', ')}` : ''}`,
    missing: required.filter(kind => !(kind in categories)),
    knownGaps: ['session.ended: ZCode 无专用会话结束事件（第十九批 HOST-02-ZC 登记，不假充）'],
    sanitizedReceipts: sanitized,
    pasteBack: '将本 JSON 贴回 docs/host-acceptance.md 第 3 节；能力声明升级见 packages/adapters/zcode/src/index.ts 的 zcodeDescriptor',
  }, null, 2)}\n`);
} finally { db.close(); }
