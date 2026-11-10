import { MemoryRuntime } from '../../../packages/core/application/src/runtime.ts';
import type { ClientHttpEndpoints } from '../../../packages/protocols/http/src/index.ts';
import { z } from 'zod';
import { mkdirSync, statfsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { MnemonCliProvider } from '../../../packages/providers/mnemon/src/index.ts';
import { MemoryApplication, SyncCoordinator, applyInboxEntry, archiveDraft, assertEntryVersion, planArchive, planEditChange, planRuleCreate, planRuleEdit, ruleDraft, ruleScope, submitLocalChange, toArchiveRecord, toRuleRecord } from '../../../packages/core/application/src/index.ts';
import type { FormalProviderPort, LocalWriteState } from '../../../packages/core/application/src/index.ts';
import { ViewAssembler } from '../../../packages/core/application/src/view.ts';
import { MnemoWeaveError, ArchiveCreate, HostEvent, MemoryEditInput, MemoryList, RememberInput, RuleList, SyncRefreshOutput, SyncStatusOutput, ViewRequest } from '../../../packages/core/contracts/src/index.ts';
import type { ReadGrantRecord, SyncEntryDraftValue } from '../../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../../packages/infrastructure/governance/src/index.ts';
import { SyncClient } from '../../../packages/infrastructure/sync-client/src/index.ts';
import { SyncService } from './sync-service.ts';
import { isAbsolute, join } from 'node:path';
import { resolve } from 'node:path';
import { MemoryWorkflow } from '../../../packages/core/application/src/workflow.ts';
import { ChatModelGateway, fileUsageSink, stderrUsageSink } from '../../../packages/infrastructure/model-gateway/src/index.ts';
import type { ModelRoute } from '../../../packages/infrastructure/model-gateway/src/index.ts';
import { VersionWorkflow } from '../../../packages/core/application/src/version-workflow.ts';

const Config = z.object({
  MNEMON_BINARY: z.string().min(1).default('mnemon'), MNEMON_DATA_DIR: z.string().min(1), MNEMON_STORE: z.string().regex(/^[a-zA-Z0-9_-]+$/),
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
  // Remote sync is optional; all three credentials must be present together or none.
  MNEMOWEAVE_SYNC_URL: z.url().optional(),
  MNEMOWEAVE_SYNC_DEVICE_ID: z.string().trim().min(1).max(200).optional(),
  MNEMOWEAVE_SYNC_TOKEN: z.string().min(24).optional(),
  MNEMOWEAVE_SYNC_INTERVAL_MS: z.coerce.number().int().nonnegative().default(300000),
  MNEMOWEAVE_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
});
/** Free-space floor guard for the worker; statfs errors fail open (no silent lockup). */
function diskFloorGuard(dir: string, minFreeBytes: number): () => boolean {
  return () => {
    try {
      const stats = statfsSync(dir); return stats.bavail * stats.bsize >= minFreeBytes;
    } catch { return true; }
  };
}

/**
 * Host clients authenticate with the service token and identify themselves through
 * `x-mnemoweave-host`. Without per-host grants the effective scope is the whole store, so the
 * synthetic grant only carries the caller identity; there is nothing to revoke or expire.
 */
function clientGrant(hostId: string): ReadGrantRecord {
  const now = Date.now();
  return {
    grantId: randomUUID(), hostId, projects: ['*'], globalIncluded: true,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 365 * 86_400_000).toISOString(), generation: 0,
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
  let sync: SyncService | undefined;
  let coordinator: SyncCoordinator | undefined;
  let formalProvider: FormalProviderPort | undefined;
  try {
    candidates?.bindProvider(JSON.stringify({ directory: resolve(config.MNEMON_DATA_DIR), store: config.MNEMON_STORE }));
    if (!!config.MNEMOWEAVE_MODEL_URL !== !!config.MNEMOWEAVE_MODEL) throw new Error('Model route requires both URL and model');
    if (!!config.MNEMOWEAVE_BACKUP_MODEL_URL !== !!config.MNEMOWEAVE_BACKUP_MODEL) throw new Error('Backup model route requires both URL and model');
    const syncConfigured = !!config.MNEMOWEAVE_SYNC_URL || !!config.MNEMOWEAVE_SYNC_DEVICE_ID || !!config.MNEMOWEAVE_SYNC_TOKEN;
    if (syncConfigured && !(config.MNEMOWEAVE_SYNC_URL && config.MNEMOWEAVE_SYNC_DEVICE_ID && config.MNEMOWEAVE_SYNC_TOKEN)) throw new Error('Remote sync requires URL, device id and token together');
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
    let client: ClientHttpEndpoints | undefined;
    if (candidates && config.MNEMOWEAVE_STATE_DIR) {
      // VIEW-01/02: assembly re-checks publication state and budget; grants are implicit now.
      // Rules are read per assembly: global ones always, project ones only for a project request.
      const ruleSource = ({ projectId }: { projectId?: string }) => [
        ...candidates.memory.rulesFor('global', null),
        ...(projectId ? candidates.memory.rulesFor('project', projectId) : []),
      ].map(row => ({ entryId: row.entryId, version: row.version, body: row.body }));
      const assembler = new ViewAssembler(app, { ...(gateway ? { reranker: gateway } : {}), rules: ruleSource });
      const memoryRuntime = new MemoryRuntime(candidates.runtime, assembler);
      // A local write is applied here first; when sync is configured the same change is
      // queued and one flush is attempted, and the remote's answer decides the error.
      const submitLocal = async (scope: string, operation: 'create' | 'update' | 'delete', entry: SyncEntryDraftValue, baseVersion: number): Promise<LocalWriteState | 'local_only'> => {
        if (!coordinator) return 'local_only';
        const result = await submitLocalChange({ scope, operation, entry, baseVersion }, {
          ledger: candidates.ledger,
          flush: () => coordinator!.flushOutbox(),
          now: () => new Date().toISOString(),
        });
        return result.state;
      };
      client = {
        view: async (hostId, input) => {
          const request = ViewRequest.parse(input);
          const view = await memoryRuntime.view(clientGrant(hostId), request);
          candidates.memory.recordInjection({
            id: randomUUID(), hostId, sessionId: request.sessionId ?? 'unspecified',
            rulesInjected: view.rules?.length ?? 0,
            rulesOmitted: view.rulesBudget?.exceeded ? 'budget_exceeded' : null,
            memoriesInjected: view.memories.length,
            usedTokens: view.budget.usedTokens,
            createdAt: new Date().toISOString(),
          });
          return view;
        },
        context: (hostId, input) => {
          if (input.close) candidates.runtime.closeSession(hostId, input.sessionId);
          const context = candidates.runtime.context(hostId, input.sessionId, input.projectId, input.task);
          return { ...context, pins: [...context.pins] };
        },
        pin: input => { candidates.catalog.get(input.memoryId); candidates.runtime.pin(input); },
        register: projectId => candidates.runtime.register(projectId),
        closeSession: (hostId, sessionId) => candidates.runtime.closeSession(hostId, sessionId),
        events: (hostId, input) => {
          const result = candidates.events.record(hostId, input);
          // The runtime projection has its own idempotency; retention skipping must not hide events from it.
          candidates.runtime.observe(hostId, HostEvent.parse(input));
          return result;
        },
        memories: async ({ query, limit }) => {
          const terms = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
          const items: Array<Record<string, unknown>> = [];
          for (const providerId of candidates.catalog.visibleProviderIds()) {
            for (const memoryId of candidates.catalog.currentMemoryIds(providerId)) {
              const descriptor = candidates.catalog.get(memoryId);
              if (descriptor.state !== 'active') continue;
              const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
              if (!current) continue;
              let content: string;
              try { content = (await provider.readMemory(providerId)).content; } catch { continue; }
              if (terms.length > 0 && !terms.every(term => content.toLowerCase().includes(term))) continue;
              items.push({
                memoryId, revisionId: current.id, providerMemoryId: providerId,
                scope: descriptor.scope, ...(descriptor.projectId ? { projectId: descriptor.projectId } : {}),
                applicability: descriptor.applicability, publishedAt: current.publishedAt, content,
                entryVersion: candidates.memory.entryVersion(memoryId),
              });
              if (items.length >= limit) return MemoryList.parse({ items });
            }
          }
          return MemoryList.parse({ items });
        },
        editMemory: async (memoryId, input) => {
          const parsed = MemoryEditInput.parse(input);
          const descriptor = candidates.catalog.get(memoryId);
          if (descriptor.state !== 'active') throw new MnemoWeaveError('INVALID_STATE');
          const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
          if (!current) throw new MnemoWeaveError('NOT_FOUND');
          const currentVersion = candidates.memory.entryVersion(memoryId);
          assertEntryVersion(currentVersion, parsed.entryVersion);
          const now = new Date().toISOString();
          const reason = parsed.reason ?? 'user edit from DSH memory page';
          const hash = createHash('sha256').update(parsed.content).digest('hex');
          const scope = descriptor.scope === 'global' ? 'global' : `project:${descriptor.projectId}`;
          let providerId: string;
          let entryVersion: number;
          if (coordinator && formalProvider) {
            // The remote confirms first: a local Provider write that the remote then
            // rejects would leave an unreferenced memory behind.
            const plan = planEditChange({ entryId: memoryId, scope, content: parsed.content, entryVersion: currentVersion });
            const result = await submitLocal(plan.scope, plan.operation, plan.entry, plan.baseVersion);
            if (result === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
            if (result === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
            await coordinator.applyScope(scope, row => applyInboxEntry(row, { store: candidates.memory, provider: formalProvider! }));
            entryVersion = candidates.memory.entryVersion(memoryId);
            const mapped = candidates.memory.formalProviderId(memoryId, entryVersion);
            if (!mapped) throw new MnemoWeaveError('NEEDS_REVIEW');
            providerId = mapped;
          } else {
            const written = await provider.persistReviewed(parsed.content, `candidate:${randomUUID()}`);
            await provider.linkSupersedes(written.id, current.providerMemoryId, { operationId: randomUUID(), reason, effectiveAt: now });
            providerId = written.id;
            entryVersion = currentVersion + 1;
            candidates.memory.upsertFormalMap({ entryId: memoryId, version: entryVersion, providerId, contentHash: hash, state: 'applied', appliedAt: now }, now);
            candidates.memory.setEntryVersion(memoryId, entryVersion, now);
          }
          const request = RememberInput.parse({
            idempotencyKey: `edit-${randomUUID()}`.slice(0, 128), content: parsed.content, knowledgeType: 'Practice', tags: [],
            scope: descriptor.scope, ...(descriptor.projectId ? { projectId: descriptor.projectId } : {}),
            provenance: {
              source: 'local-user', sourceReference: `dsh-edit:${memoryId}`, evidence: [reason], verificationStatus: 'verified',
              confidence: 1, applicability: descriptor.applicability, limitations: '无（用户直接编辑）', lastVerified: now,
            },
          });
          const published = candidates.catalog.publishDirectEdit(memoryId, request, providerId, hash, now, 'local-user', reason);
          return { memoryId, revisionId: published.revisionId, providerMemoryId: providerId, contentHash: hash, entryVersion };
        },
        lastInjection: async (hostId, sessionId) => candidates.memory.lastInjection(hostId, sessionId),
        rules: async ({ scope, projectId }) => RuleList.parse({
          items: (scope === 'all' ? candidates.memory.everyRule() : candidates.memory.allRules(scope, projectId ?? null)).map(toRuleRecord),
        }),
        createRule: async (input) => {
          const existing = input.scope === 'global'
            ? candidates.memory.allRules('global', null)
            : [...candidates.memory.allRules('global', null), ...candidates.memory.allRules('project', input.projectId!)];
          const row = planRuleCreate(input, existing);
          candidates.memory.upsertRule(row, new Date().toISOString());
          await submitLocal(ruleScope(row), 'create', ruleDraft(row), 0);
          return toRuleRecord(row);
        },
        editRule: async (ruleId, input) => {
          const current = candidates.memory.rule(ruleId);
          if (!current) throw new MnemoWeaveError('NOT_FOUND');
          const existing = current.scope === 'global'
            ? candidates.memory.allRules('global', null)
            : [...candidates.memory.allRules('global', null), ...candidates.memory.allRules('project', current.projectId)];
          const row = planRuleEdit(current, input, existing);
          candidates.memory.upsertRule(row, new Date().toISOString());
          const baseVersion = candidates.memory.entryVersion(ruleId);
          await submitLocal(ruleScope(row), baseVersion === 0 ? 'create' : 'update', ruleDraft(row), baseVersion);
          return toRuleRecord(row);
        },
        archives: async ({ projectId, includeWithdrawn }) => ({
          items: (projectId === undefined
            ? candidates.memory.allArchives(includeWithdrawn ?? false)
            : candidates.memory.archivesFor(projectId, includeWithdrawn ?? false)).map(toArchiveRecord),
        }),
        createArchive: async (input) => {
          const row = planArchive(ArchiveCreate.parse(input));
          candidates.memory.upsertArchive(row, new Date().toISOString());
          await submitLocal(`project:${row.projectId}`, 'create', archiveDraft(row), 0);
          return toArchiveRecord(row);
        },
      };
      if (config.MNEMOWEAVE_SYNC_URL && config.MNEMOWEAVE_SYNC_DEVICE_ID && config.MNEMOWEAVE_SYNC_TOKEN) {
        const syncClient = new SyncClient({ baseUrl: config.MNEMOWEAVE_SYNC_URL, deviceId: config.MNEMOWEAVE_SYNC_DEVICE_ID, token: config.MNEMOWEAVE_SYNC_TOKEN, timeoutMs: config.MNEMOWEAVE_SYNC_TIMEOUT_MS });
        const formal = {
          remember: async (content: string, source: string) => {
            const match = /^mnemoweave:([0-9a-f-]{36}):(\d+)$/.exec(source);
            if (!match) throw new MnemoWeaveError('INVALID_INPUT');
            return provider.syncRemember(content, match[1]!, Number(match[2]));
          },
          linkSupersedes: (sourceId: string, targetId: string, metadata: { operationId: string; reason: string; effectiveAt: string }) => provider.linkSupersedes(sourceId, targetId, metadata),
          show: async (id: string) => provider.readMemory(id),
          forget: async (id: string) => provider.forget(id),
        };
        formalProvider = formal;
        coordinator = new SyncCoordinator(syncClient, candidates.ledger);
        const service = new SyncService({
          remote: syncClient,
          coordinator,
          ledger: candidates.ledger,
          apply: row => applyInboxEntry(row, { store: candidates.memory, provider: formal }),
          intervalMs: config.MNEMOWEAVE_SYNC_INTERVAL_MS,
        });
        sync = service;
        client.syncStatus = async () => SyncStatusOutput.parse(service.status());
        client.syncRefresh = async () => SyncRefreshOutput.parse(await service.refresh());
        service.start();
      }
    }
    return { app, port: config.MNEMOWEAVE_PORT, close: async () => { sync?.stop(); await workflow?.stop(); candidates?.close(); }, client, storage: candidates ? () => candidates.storageStatus() : undefined };
  } catch (error) { candidates?.close(); throw error; }
}
