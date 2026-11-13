import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { ARCHIVE_ACTIVE_CAPACITY_BYTES, LegacyWorkspaceMap, RULE_CAPACITY_BYTES } from '../../../packages/core/contracts/src/index.ts';
import { SyncStore } from '../../../packages/infrastructure/sync-store/src/index.ts';
import { createSyncServer, SYNC_PROTOCOL_VERSION } from '../../../packages/protocols/sync-http/src/index.ts';
import { createEnrollment } from './enrollment.ts';

/**
 * Remote sync Server. It holds versions and change receipts only: no Mnemon, no
 * injection, no recall. TLS is terminated by the deployment layer, so the process
 * binds loopback and expects a reverse proxy in front of it.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    process.stderr.write(`${JSON.stringify({ error: 'CONFIG_MISSING', variable: name })}\n`);
    process.exit(1);
  }
  return value.trim();
}

const port = Number(process.env['MNEMOWEAVE_SYNC_PORT'] ?? '4318');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`${JSON.stringify({ error: 'CONFIG_INVALID', variable: 'MNEMOWEAVE_SYNC_PORT' })}\n`);
  process.exit(1);
}
const host = process.env['MNEMOWEAVE_SYNC_HOST']?.trim() || '127.0.0.1';
const trustedEnrollmentProxy = process.env['MNEMOWEAVE_SYNC_ENROLLMENT_PROXY_IP'];
if (trustedEnrollmentProxy !== undefined && !isIP(trustedEnrollmentProxy)) {
  throw new Error('MNEMOWEAVE_SYNC_ENROLLMENT_PROXY_IP must be a single IP address');
}
const stateDir = requireEnv('MNEMOWEAVE_SYNC_STATE_DIR');
mkdirSync(stateDir, { recursive: true });

const mapPath = process.env['MNEMOWEAVE_LEGACY_WORKSPACE_MAP'];
const store = new SyncStore({
  path: join(stateDir, 'sync.db'),
  ruleCapacityBytes: boundedInt('MNEMOWEAVE_RULE_CAPACITY_BYTES', RULE_CAPACITY_BYTES, 1),
  archiveCapacityBytes: boundedInt('MNEMOWEAVE_ARCHIVE_ACTIVE_CAPACITY_BYTES', ARCHIVE_ACTIVE_CAPACITY_BYTES, 1),
  ...(mapPath ? { legacyWorkspaces: LegacyWorkspaceMap.parse(JSON.parse(readFileSync(mapPath, 'utf8'))) } : {}),
});
const server = createSyncServer({
  gateway: store,
  enrollment: createEnrollment(store, process.env['MNEMOWEAVE_SYNC_BOOTSTRAP_TOKEN']),
  enrollmentSource: request => {
    const peer = request.socket.remoteAddress;
    const forwarded = request.headers['x-real-ip'];
    return peer === trustedEnrollmentProxy && typeof forwarded === 'string' && isIP(forwarded)
      ? forwarded : peer ?? 'unknown';
  },
});

// Change retention is a maintenance job, not a request path: run it at startup and
// then on an interval. 0 disables the interval; the startup pass still runs.
const pruneIntervalMs = Number(process.env['MNEMOWEAVE_SYNC_PRUNE_INTERVAL_MS'] ?? String(6 * 60 * 60 * 1000));
if (!Number.isInteger(pruneIntervalMs) || pruneIntervalMs < 0) {
  process.stderr.write(`${JSON.stringify({ error: 'CONFIG_INVALID', variable: 'MNEMOWEAVE_SYNC_PRUNE_INTERVAL_MS' })}\n`);
  process.exit(1);
}

function boundedInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    process.stderr.write(`${JSON.stringify({ error: 'CONFIG_INVALID', variable: name })}\n`);
    process.exit(1);
  }
  return value;
}

const retentionDays = boundedInt('MNEMOWEAVE_SYNC_RETENTION_DAYS', 90, 1);
const maxChangesPerStream = boundedInt('MNEMOWEAVE_SYNC_MAX_CHANGES', 50_000, 1);
const receiptDays = boundedInt('MNEMOWEAVE_SYNC_RECEIPT_DAYS', 365, 1);

function prune(): void {
  try {
    const result = store.prune({ retentionDays, maxChangesPerStream, receiptDays });
    process.stderr.write(`${JSON.stringify({ event: 'prune', ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'prune_failed', error: error instanceof Error ? error.message : 'unknown' })}\n`);
  }
}

prune();
if (pruneIntervalMs > 0) setInterval(prune, pruneIntervalMs).unref();

server.listen(port, host, () => {
  process.stderr.write(`${JSON.stringify({ listening: `http://${host}:${port}`, protocol: SYNC_PROTOCOL_VERSION, version: '0.2.0' })}\n`);
});

function shutdown(signal: string): void {
  process.stderr.write(`${JSON.stringify({ event: 'shutdown', signal })}\n`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
