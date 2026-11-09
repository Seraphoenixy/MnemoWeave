import { MemoryRuntime } from '../../../packages/core/application/src/runtime.ts';
import type { RuntimeHttpEndpoints } from '../../../packages/protocols/http/src/index.ts';
import { z } from 'zod';
import { mkdirSync, statfsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SyncSource } from '../../../packages/infrastructure/governance/src/sync-source.ts';
import type { SyncHttpEndpoints } from '../../../packages/protocols/http/src/index.ts';
import { MnemonCliProvider } from '../../../packages/providers/mnemon/src/index.ts';
import { MemoryApplication } from '../../../packages/core/application/src/index.ts';
import { ViewAssembler } from '../../../packages/core/application/src/view.ts';
import { MnemoWeaveError, ViewRequest } from '../../../packages/core/contracts/src/index.ts';
import type { ViewRecord } from '../../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../../packages/infrastructure/governance/src/index.ts';
import { isAbsolute, join } from 'node:path';
import { resolve } from 'node:path';
import { MemoryWorkflow } from '../../../packages/core/application/src/workflow.ts';
import { ChatModelGateway, fileUsageSink, stderrUsageSink } from '../../../packages/infrastructure/model-gateway/src/index.ts';
import type { ModelRoute } from '../../../packages/infrastructure/model-gateway/src/index.ts';
import { VersionWorkflow } from '../../../packages/core/application/src/version-workflow.ts';

const Config = z.object({
  MNEMON_BINARY: z.string().min(1), MNEMON_DATA_DIR: z.string().min(1), MNEMON_STORE: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  MNEMOWEAVE_PORT: z.coerce.number().int().min(0).max(65535).default(4317),
  MNEMOWEAVE_STATE_DIR: z.string().refine(isAbsolute, 'State directory must be absolute').optional(),
  MNEMOWEAVE_WORKER: z.enum(['on', 'off']).default('on'),
  MNEMOWEAVE_MODEL_URL: z.url().optional(),
  MNEMOWEAVE_MODEL: z.string().min(1).optional(),
  MNEMOWEAVE_MODEL_KEY: z.string().min(1).optional(),
  MNEMOWEAVE_BACKUP_MODEL_URL: z.url().optional(),
  MNEMOWEAVE_BACKUP_MODEL: z.string().min(1).optional(),
  MNEMOWEAVE_BACKUP_MODEL_KEY: z.string().min(1).optional(),
  // STORAGE-02: no fixed quota is preconfigured; this floor only stops the worker before disk exhaustion.
  MNEMOWEAVE_MIN_FREE_BYTES: z.coerce.number().int().nonnegative().optional(),
  MNEMOWEAVE_QUOTA_SOFT_BYTES: z.coerce.number().int().nonnegative().default(10 * 1024 ** 3),
  MNEMOWEAVE_QUOTA_HARD_BYTES: z.coerce.number().int().nonnegative().default(20 * 1024 ** 3),
});
/** Free-space floor guard for the worker; statfs errors fail open (no silent lockup). */
function diskFloorGuard(dir: string, minFreeBytes: number): () => boolean {
  return () => {
    try { const stats = statfsSync(dir); return stats.bavail * stats.bsize >= minFreeBytes; } catch { return true; }
  };
}

export function configure(env: NodeJS.ProcessEnv = process.env) {
  const config = Config.parse(env);
  if (config.MNEMOWEAVE_QUOTA_SOFT_BYTES >= config.MNEMOWEAVE_QUOTA_HARD_BYTES) throw new Error('Quota soft limit must be below the hard limit');
  const provider = new MnemonCliProvider({ binary: config.MNEMON_BINARY, dataDir: config.MNEMON_DATA_DIR, store: config.MNEMON_STORE });
  const candidates = config.MNEMOWEAVE_STATE_DIR
    ? new SqliteCandidates(join(config.MNEMOWEAVE_STATE_DIR, 'governance.db'), { softBytes: config.MNEMOWEAVE_QUOTA_SOFT_BYTES, hardBytes: config.MNEMOWEAVE_QUOTA_HARD_BYTES })
    : undefined;
  let workflow: MemoryWorkflow | undefined;
  try {
    candidates?.bindProvider(JSON.stringify({ directory: resolve(config.MNEMON_DATA_DIR), store: config.MNEMON_STORE }));
    if (!!config.MNEMOWEAVE_MODEL_URL !== !!config.MNEMOWEAVE_MODEL) throw new Error('Model route requires both URL and model');
    if (!!config.MNEMOWEAVE_BACKUP_MODEL_URL !== !!config.MNEMOWEAVE_BACKUP_MODEL) throw new Error('Backup model route requires both URL and model');
    // Task→capability→route table: every route must declare the capability its task requires.
    const routes: ModelRoute[] = [];
    if (config.MNEMOWEAVE_MODEL_URL) routes.push({ url: config.MNEMOWEAVE_MODEL_URL, model: config.MNEMOWEAVE_MODEL!, capabilities: ['semantic-assessment', 'semantic-rerank', 'semantic-capture'], ...(config.MNEMOWEAVE_MODEL_KEY ? { apiKey: config.MNEMOWEAVE_MODEL_KEY } : {}) });
    if (config.MNEMOWEAVE_BACKUP_MODEL_URL) routes.push({ url: config.MNEMOWEAVE_BACKUP_MODEL_URL, model: config.MNEMOWEAVE_BACKUP_MODEL!, capabilities: ['semantic-assessment', 'semantic-rerank', 'semantic-capture'], ...(config.MNEMOWEAVE_BACKUP_MODEL_KEY ? { apiKey: config.MNEMOWEAVE_BACKUP_MODEL_KEY } : {}) });
    const gateway = routes.length ? new ChatModelGateway({ routes, usageSink: config.MNEMOWEAVE_STATE_DIR ? fileUsageSink(join(config.MNEMOWEAVE_STATE_DIR, 'model-usage.jsonl')) : stderrUsageSink() }) : undefined;
    if (candidates && config.MNEMOWEAVE_WORKER === 'on') {
      const admit = config.MNEMOWEAVE_MIN_FREE_BYTES === undefined ? undefined : diskFloorGuard(config.MNEMOWEAVE_STATE_DIR!, config.MNEMOWEAVE_MIN_FREE_BYTES);
      workflow = new MemoryWorkflow(candidates, provider, gateway, 90000, new VersionWorkflow(candidates, provider), 2, admit, 3_600_000, () => candidates.runtime.tick(gateway)); workflow.start();
    }
    const app = new MemoryApplication(provider, candidates, candidates);
    // WP6 transport: the Bridge reaches the sync protocol over HTTP (host identity = paired grant).
    let runtime: RuntimeHttpEndpoints | undefined;
    let sync: SyncHttpEndpoints | undefined;
    let view: ((hostId: string, input: unknown) => Promise<ViewRecord>) | undefined;
    if (candidates && config.MNEMOWEAVE_STATE_DIR) {
      const source = new SyncSource(candidates, async providerMemoryId => (await provider.readMemory(providerMemoryId)).content);
      const snapshotDir = join(config.MNEMOWEAVE_STATE_DIR, 'sync-snapshots');
      sync = {
        scoped: true, requireHostCredential: true,
        currentGrant: hostId => source.grantFor(hostId),
        issueGrant: async (hostId, projects, globalIncluded, ttlMs) => source.issueGrant(hostId, projects, globalIncluded, ttlMs),
        revoke: async (hostId, global) => { source.revokeHost(hostId, global); },
        isRevoked: async hostId => source.isHostRevoked(hostId),
        watermark: () => source.revocationWatermark(),
        changes: (sinceSeq, hostId) => source.changes(sinceSeq, undefined, hostId ? source.grantFor(hostId) : undefined),
        snapshot: async hostId => {
          mkdirSync(snapshotDir, { recursive: true });
          const path = join(snapshotDir, `snapshot-${randomUUID()}.db`);
          const manifest = await source.snapshot(path, undefined, hostId ? source.grantFor(hostId) : undefined);
          return { path, latestSeq: manifest.latestSeq };
        },
        partitionSummaries: async hostId => source.partitionSummaries(hostId ? source.grantFor(hostId) : undefined),
        submitIntent: async (hostId, intent) => source.submitIntent(hostId, { intentId: intent.intentId, kind: intent.kind, payload: intent.payload, ...(intent.baselineRef !== undefined ? { baselineRef: intent.baselineRef } : {}) }),
      };
      // VIEW-01/02: assembly re-checks grant expiry, revocation, publication state and budget.
      const assembler = new ViewAssembler(app, { revocations: source, ...(gateway ? { reranker: gateway } : {}) });
      const memoryRuntime = new MemoryRuntime(candidates.runtime, assembler);
      runtime = {
        context: (hostId, input) => {
          if (source.isHostRevoked(hostId)) throw new MnemoWeaveError('UNAUTHORIZED');
          const grant = source.grantFor(hostId)!;
          if (input.projectId && !grant.projects.includes('*') && !grant.projects.includes(input.projectId)) throw new MnemoWeaveError('UNAUTHORIZED');
          if (input.close) candidates.runtime.closeSession(hostId, input.sessionId);
          const context = candidates.runtime.context(hostId, input.sessionId, input.projectId, input.task);
          if (context.projectId && !grant.projects.includes('*') && !grant.projects.includes(context.projectId)) throw new MnemoWeaveError('UNAUTHORIZED');
          return { ...context, pins: context.pins.filter(pin => { const descriptor = candidates.catalog.get(pin.memoryId); return descriptor.scope === 'global' ? grant.globalIncluded : grant.projects.includes('*') || descriptor.projectId !== undefined && grant.projects.includes(descriptor.projectId); }) };
        },
        pin: input => { candidates.catalog.get(input.memoryId); candidates.runtime.pin(input); },
        register: projectId => candidates.runtime.register(projectId),
      };
      view = async (hostId, input) => {
        if (await source.isHostRevoked(hostId)) throw new MnemoWeaveError('UNAUTHORIZED');
        const grant = source.grantFor(hostId);
        if (!grant) throw new MnemoWeaveError('UNAUTHORIZED');
        const request = ViewRequest.parse(input);
        const result = await memoryRuntime.view(grant, request);
        if (source.isHostRevoked(hostId) || source.grantFor(hostId)?.grantId !== grant.grantId) throw new MnemoWeaveError('UNAUTHORIZED');
        return result;
      };
    }
    return { app, port: config.MNEMOWEAVE_PORT, close: async () => { await workflow?.stop(); candidates?.close(); }, sync, view, runtime, storage: candidates ? () => candidates.storageStatus() : undefined };
  } catch (error) { candidates?.close(); throw error; }
}
