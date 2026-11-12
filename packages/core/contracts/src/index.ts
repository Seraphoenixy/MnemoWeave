import { z } from 'zod';
import { ARCHIVE_SEARCH_LIMIT_MAX } from './capacity.ts';
import { DiagnosticJob, EmbeddingDiagnostics } from './provider.ts';
import { Candidate, ConflictDescriptor, ConflictResolutionInput, ExploreInput, ExploreOutput, HumanReviewInput, MemoryCreateInput, MemoryCreateOutput, MemoryEditInput, MemoryEditOutput, MemoryGraph, MemoryGraphQuery, MemoryList, MemoryWithdrawInput, MemoryWithdrawOutput, PublishedMemoryOutput, RememberInput, RetryInput, StorageStatus, CancelVersionInput, Category, MemoryReadOutput } from './catalog.ts';
import { ArchiveCreate, ArchiveEdit, ArchiveHistory, ArchiveList, ArchiveRecord, ArchiveReleaseCandidates, ArchiveSearchInput, ArchiveSearchOutput, ArchiveSegmentInput, ArchiveSegmentOutput, ArchiveStateInput, RuleArchiveList, RuleCreate, RuleEdit, RuleList, RuleRecord, SessionWorkspaceInput, SessionWorkspaceRecord, WorkspaceCreate, WorkspaceList, WorkspaceRecord } from './workspace.ts';
import { HostEvent, IdleReviewPendingOutput, IdleReviewRun, IdleReviewRunFinishInput, IdleReviewRunItem, IdleReviewRunStartInput, IdleReviewRunStartOutput, IdleReviewRunsOutput, IdleReviewScanInput, IdleReviewScanOutput, IdleReviewSignalsOutput, InjectRequest, InjectionOutput, InjectionReport } from './host.ts';
import { ArchiveDistillationCreate, ArchiveDistillationRecord, FormalMemoryTaskAction, RuleTaskAction, WorkspaceArchiveTaskAction, WriteTaskAction, WriteTaskReceipt } from './write-task.ts';
import { SyncRefreshOutput, SyncStatusOutput } from './sync.ts';
import { ProviderHealth, RecallInput, RecallOutput } from './provider.ts';

export * from './capacity.ts';
export * from './errors.ts';
export * from './provider.ts';
export * from './catalog.ts';
export * from './workspace.ts';
export * from './host.ts';
export * from './write-task.ts';
export * from './sync.ts';

// ── OpenAPI ──
const jsonContent = (schema: z.ZodType) => ({ 'application/json': { schema: z.toJSONSchema(schema) } });
const hostHeader = { name: 'x-mnemoweave-host', in: 'header', required: true, schema: { type: 'string', minLength: 1 } } as const;

export const openapi = {
  openapi: '3.1.0',
  info: { title: 'MnemoWeave development API', version: '0.2.0' },
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
      operator: { type: 'http', scheme: 'bearer', description: 'Independent operator token; never pass to a model Host' },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    '/health/live': { get: {
      description: 'Process liveness. Still requires the service token. `service` and `protocol` identify the responder so a host can tell this Server apart from another program holding the port; a rejected token carries the same identity fields so a host reports a token mismatch rather than an intruder.',
      responses: {
        '200': { description: 'Process is live', content: jsonContent(z.object({ live: z.literal(true), service: z.literal('mnemoweave'), protocol: z.number().int().positive() }).strict()) },
        '401': { description: 'Unauthorized; the body still names this service', content: jsonContent(z.object({ code: z.string(), service: z.literal('mnemoweave'), protocol: z.number().int().positive(), traceId: z.string() })) },
      },
    } },
    '/health/ready': { get: {
      description: 'Provider dependency readiness.',
      responses: { '200': { description: 'Provider health', content: jsonContent(ProviderHealth) }, '401': { description: 'Unauthorized' }, '503': { description: 'Provider unavailable' } },
    } },
    '/openapi.json': { get: {
      description: 'This contract document.',
      responses: { '200': { description: 'OpenAPI 3.1 document' }, '401': { description: 'Unauthorized' } },
    } },
    '/v1/storage': { get: {
      description: 'Capacity state for the governance store. Soft prompts cleanup; hard rejects non-critical growth.',
      responses: { '200': { description: 'Storage status', content: jsonContent(StorageStatus) }, '401': { description: 'Unauthorized' } },
    } },
    '/v1/inject': { post: {
      description: 'Return the complete set of visible enabled rules for one session. No aggregate View, no session projection and no memory selection: archives and formal memories are read through tools. Ordered by creation time then entry id.',
      parameters: [hostHeader],
      requestBody: { required: true, content: jsonContent(InjectRequest) },
      responses: {
        '200': { description: 'Every visible enabled rule, whole', content: jsonContent(InjectionOutput) },
        '400': { description: 'Invalid input' }, '401': { description: 'Missing host identity' },
        '409': { description: 'The resident rule set exceeds its capacity' },
      },
    } },
    '/v1/injections/latest': { get: {
      description: 'Last injection result for a host, or for the operator across hosts. 404 means no injection happened yet.',
      parameters: [hostHeader, { name: 'sessionId', in: 'query', schema: { type: 'string', maxLength: 200 } }],
      security: [{ operator: [] }, { bearer: [] }],
      responses: { '200': { description: 'Last injection', content: jsonContent(InjectionReport) }, '401': { description: 'Unauthorized' }, '404': { description: 'No injection yet' } },
    } },

    '/v1/rules': {
      get: {
        description: 'The shared rule collection plus its UTF-8 byte usage. Rules apply to every session; withdrawn rules are not listed.',
        security: [{ operator: [] }, { bearer: [] }],
        responses: { '200': { description: 'Rules and byte usage', content: jsonContent(RuleList) }, '401': { description: 'Unauthorized' } },
      },
      post: {
        description: 'Create one rule. A write that would exceed the capacity is refused with RULE_CAPACITY_EXCEEDED; the collection is never trimmed, compressed or archived to fit.',
        security: [{ operator: [] }, { bearer: [] }],
        requestBody: { required: true, content: jsonContent(RuleCreate) },
        responses: { '201': { description: 'Created rule', content: jsonContent(RuleRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '409': { description: 'RULE_ITEM_TOO_LARGE or RULE_CAPACITY_EXCEEDED' } },
      },
    },
    '/v1/rules/{ruleId}': { patch: {
      description: 'Edit, enable/disable or remove one rule. The caller submits the version it read; a stale baseVersion is refused with VERSION_CONFLICT. Removing appends a version and takes the text out of the resident set.',
      parameters: [{ name: 'ruleId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
      security: [{ operator: [] }, { bearer: [] }],
      requestBody: { required: true, content: jsonContent(RuleEdit) },
      responses: { '200': { description: 'Updated rule', content: jsonContent(RuleRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '404': { description: 'Rule not found' }, '409': { description: 'RULE_ITEM_TOO_LARGE, RULE_CAPACITY_EXCEEDED or VERSION_CONFLICT' } },
    } },
    '/v1/rules/archive': { get: {
      description: 'Exact rule text that left the resident set, with its source version and why.',
      security: [{ operator: [] }, { bearer: [] }],
      responses: { '200': { description: 'Archived rules', content: jsonContent(RuleArchiveList) }, '401': { description: 'Unauthorized' } },
    } },

    '/v1/workspaces': {
      get: {
        description: 'Workspaces the caller may access: id and display name only. A host response never carries a local path.',
        parameters: [hostHeader],
        responses: { '200': { description: 'Accessible workspaces', content: jsonContent(WorkspaceList) }, '401': { description: 'Unauthorized' } },
      },
      post: {
        description: 'Operator registration of one workspace. The same id with the same name is idempotent; the same id with a different name is INVALID_STATE.',
        security: [{ operator: [] }],
        requestBody: { required: true, content: jsonContent(WorkspaceCreate) },
        responses: { '201': { description: 'Registered workspace', content: jsonContent(WorkspaceRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Operator credential required' }, '409': { description: 'Same id with a different name' } },
      },
    },
    '/v1/workspaces/{workspaceId}/binding': { put: {
      description: 'Bind one local directory to a workspace. The path is resolved to a real directory before it is stored; a missing directory is INVALID_INPUT and a directory already bound to another workspace is INVALID_STATE. Bindings are idempotent additions and never transfer a directory.',
      parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
      security: [{ operator: [] }],
      responses: { '200': { description: 'Workspace after the binding' }, '400': { description: 'Invalid or unresolvable path' }, '401': { description: 'Operator credential required' }, '404': { description: 'Workspace not found' }, '409': { description: 'The directory is bound to another workspace' } },
    } },
    '/v1/sessions/{sessionId}/workspace': { put: {
      description: 'A trusted host claims the workspace one session works in. Provide the actual opened root, or the id from configuration when the host has no directory. Both must agree. An empty payload explicitly records no binding; a changed binding is INVALID_STATE.',
      parameters: [hostHeader, { name: 'sessionId', in: 'path', required: true, schema: { type: 'string', maxLength: 256 } }],
      requestBody: { required: true, content: jsonContent(SessionWorkspaceInput) },
      responses: { '200': { description: 'Recorded binding', content: jsonContent(SessionWorkspaceRecord) }, '400': { description: 'Invalid or unmatched workspace' }, '401': { description: 'Missing host identity' }, '403': { description: 'The workspace is outside this host\'s access' }, '409': { description: 'The session already has a different binding' } },
    } },

    '/v1/archives': {
      get: {
        description: 'Management list for one workspace: full bodies for pagination and editing, plus that workspace\'s capacity. A missing workspaceId is WORKSPACE_REQUIRED; model-facing code uses the bounded search endpoint instead.',
        parameters: [hostHeader, { name: 'workspaceId', in: 'query', required: true, schema: z.toJSONSchema(z.uuid()) }, { name: 'includeWithdrawn', in: 'query', schema: { type: 'boolean' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }],
        security: [{ operator: [] }, { bearer: [] }],
        responses: { '200': { description: 'Archives and workspace capacity', content: jsonContent(ArchiveList) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '409': { description: 'WORKSPACE_REQUIRED' } },
      },
      post: {
        description: 'Create one workspace archive. The 2 MiB body limit and the workspace active capacity are checked before writing.',
        security: [{ operator: [] }, { bearer: [] }],
        requestBody: { required: true, content: jsonContent(ArchiveCreate) },
        responses: { '201': { description: 'Created archive', content: jsonContent(ArchiveRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '409': { description: 'ARCHIVE_BODY_TOO_LARGE or ARCHIVE_CAPACITY_EXCEEDED' } },
      },
    },
    '/v1/archives/{entryId}': { patch: {
      description: 'Edit an active archive using the version the editor read. The target workspace is derived from the entry; a workspace of another scope is NOT_FOUND.',
      parameters: [hostHeader, { name: 'entryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: jsonContent(ArchiveEdit) },
      responses: { '200': { description: 'Updated archive', content: jsonContent(ArchiveRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '404': { description: 'Archive not found' }, '409': { description: 'VERSION_CONFLICT, ARCHIVE_BODY_TOO_LARGE or ARCHIVE_CAPACITY_EXCEEDED' } },
    } },
    '/v1/archives/{entryId}/state': { post: {
      description: 'Move one archive between active and archived without losing its text, version or history. Restoring checks active byte capacity first.',
      parameters: [hostHeader, { name: 'entryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: jsonContent(ArchiveStateInput) },
      responses: { '200': { description: 'Updated archive', content: jsonContent(ArchiveRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '404': { description: 'Archive not found' }, '409': { description: 'VERSION_CONFLICT, ARCHIVE_NOT_ACTIVE or ARCHIVE_CAPACITY_EXCEEDED' } },
    } },
    '/v1/archives/{entryId}/history': { get: {
      description: 'Every recorded version of one archive, including active/archived transitions, newest first.',
      parameters: [hostHeader, { name: 'entryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { '200': { description: 'Archive history', content: jsonContent(ArchiveHistory) }, '401': { description: 'Unauthorized' }, '404': { description: 'Archive not found' } },
    } },
    '/v1/archives/{entryId}/content': { get: {
      description: 'Read one segment of an archive body for the model. Without a cursor the read starts at the beginning; the cursor is bound to host, session, entry and version, and a new version invalidates it.',
      parameters: [hostHeader, { name: 'entryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }],
      responses: { '200': { description: 'Body segment and the next cursor', content: jsonContent(ArchiveSegmentOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '404': { description: 'Archive not found in the bound workspace' }, '409': { description: 'WORKSPACE_REQUIRED, VERSION_CONFLICT or the per-turn call budget' } },
    } },
    '/v1/archives/release-candidates': { get: {
      description: 'Capacity maintenance: the active archives of one workspace whose release would free room, oldest-confirmed first. Nothing is archived by this read.',
      parameters: [
        hostHeader,
        { name: 'workspaceId', in: 'query', required: true, schema: z.toJSONSchema(z.uuid()) },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      ],
      responses: {
        '200': { description: 'Release candidates and the current capacity', content: jsonContent(ArchiveReleaseCandidates) },
        '400': { description: 'Invalid input' },
        '401': { description: 'Unauthorized' },
        '409': { description: 'A workspace is required' },
      },
    } },
    '/v1/archives/search': { get: {
      description: 'Bounded archive search for one workspace: small result count, per-result excerpt and total excerpt characters. Used by the management page; session tools use the bound workspace automatically.',
      parameters: [
        hostHeader,
        { name: 'workspaceId', in: 'query', required: true, schema: z.toJSONSchema(z.uuid()) },
        { name: 'query', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: ARCHIVE_SEARCH_LIMIT_MAX } },
        { name: 'includeArchived', in: 'query', schema: { type: 'boolean' } },
      ],
      security: [{ operator: [] }, { bearer: [] }],
      responses: { '200': { description: 'Search hits with excerpts', content: jsonContent(ArchiveSearchOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '409': { description: 'WORKSPACE_REQUIRED or the per-turn call budget' } },
    } },

    '/v1/memories': {
      get: {
        description: 'List the shared formal-memory collection with current Provider text; an optional space-separated query filters the list. No workspace filter exists.',
        parameters: [hostHeader, { name: 'query', in: 'query', schema: { type: 'string', maxLength: 500 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'category', in: 'query', schema: z.toJSONSchema(Category) }, { name: 'entity', in: 'query', schema: { type: 'string', maxLength: 200 } }, { name: 'sort', in: 'query', schema: { type: 'string', enum: ['newest', 'oldest', 'importance'] } }],
        responses: { '200': { description: 'Memory list', content: jsonContent(MemoryList) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '503': { description: 'Provider unavailable' } },
      },
      post: {
        description: 'Create a formal memory directly, without a review round. User input is treated as already-confirmed knowledge; the write still goes through the ordinary publication pipeline and is recorded as a local-user decision. Model output has no such path.',
        parameters: [hostHeader],
        requestBody: { required: true, content: jsonContent(MemoryCreateInput) },
        responses: { '200': { description: 'Memory published or found duplicate', content: jsonContent(MemoryCreateOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Missing host identity' }, '409': { description: 'The publisher is not running, or a version conflict' }, '503': { description: 'Provider unavailable, or the outcome is not yet known' } },
      },
    },
    '/v1/memories/{memoryId}': {
      get: {
        description: 'Read the selected or current published revision from the authoritative Provider and check its hash.',
        parameters: [hostHeader, { name: 'memoryId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }, { name: 'revisionId', in: 'query', schema: z.toJSONSchema(z.uuid()) }],
        responses: { '200': { description: 'Published metadata and verified Provider text', content: jsonContent(MemoryReadOutput) }, '401': { description: 'Unauthorized' }, '404': { description: 'Memory or revision not found' }, '503': { description: 'Provider missing or content integrity mismatch' } },
      },
      patch: {
        description: 'User edit: append an immutable revision, supersede the previous Provider memory and move the current pointer. The caller submits the version it read; the Server never substitutes the newest one.',
        parameters: [hostHeader, { name: 'memoryId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
        requestBody: { required: true, content: jsonContent(MemoryEditInput) },
        responses: { '200': { description: 'New revision published or found duplicate', content: jsonContent(MemoryEditOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '404': { description: 'Memory not found' }, '409': { description: 'Memory is superseded, unverified, or the base version is stale' }, '503': { description: 'Provider unavailable or content mismatch' } },
      },
    },
    '/v1/memories/{memoryId}/withdraw': { post: {
      description: 'Withdraw a published memory. Recall and injection stop serving it; its revisions remain readable. Appends the withdrawal as a new version so every machine stops recalling it.',
      parameters: [hostHeader, { name: 'memoryId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
      requestBody: { required: true, content: jsonContent(MemoryWithdrawInput) },
      responses: { '200': { description: 'Withdrawal recorded', content: jsonContent(MemoryWithdrawOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '404': { description: 'Memory not found' }, '409': { description: 'VERSION_CONFLICT, already withdrawn, or the change is queued/unknown' }, '503': { description: 'Provider unavailable' } },
    } },
    '/v1/memories/graph': { get: {
      description: 'The relation graph over the visible catalog. Structure only: a node carries what the catalog knows, not the body. Every edge has both endpoints present; withdrawn memories never appear.',
      parameters: [hostHeader, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } }],
      responses: { '200': { description: 'Nodes and edges, with `truncated` when the node cap was reached', content: jsonContent(MemoryGraph) }, '400': { description: 'An out-of-range limit' }, '401': { description: 'Missing host identity' } },
    } },
    '/v1/memories/explore': { post: {
      description: 'Provider-ranked semantic search over the shared collection, mapped to memories this machine published. An optional `hint` (a workspace display name) is appended to the query text only.',
      parameters: [hostHeader],
      requestBody: { required: true, content: jsonContent(ExploreInput) },
      responses: { '200': { description: 'Ranked hits and the count of unpublished Provider matches', content: jsonContent(ExploreOutput) }, '400': { description: 'Empty query or invalid limit' }, '401': { description: 'Missing host identity' }, '503': { description: 'Provider unavailable' } },
    } },
    '/v1/recall': { post: {
      description: 'Provider-ranked recall over the shared collection. The query may carry a workspace name appended by the host; there is no workspace parameter.',
      parameters: [hostHeader],
      requestBody: { required: true, content: jsonContent(RecallInput) },
      responses: { '200': { description: 'Recall result', content: jsonContent(RecallOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '503': { description: 'Provider unavailable' } },
    } },
    '/v1/memories/related': { post: {
      description: 'Expand relations of a memory this turn already recalled. One call per turn, bounded result count, no duplicates of what was already delivered.',
      parameters: [hostHeader],
      responses: { '200': { description: 'Related memories' }, '400': { description: 'The start memory was not recalled this turn' }, '401': { description: 'Unauthorized' }, '409': { description: 'The per-turn relation budget is spent' } },
    } },

    '/v1/remember': { post: {
      description: 'Submit a candidate only; no formal Provider write happens in this call. Hosts with a trusted turn binding but no delegation capability use this route. It never reports a publication.',
      parameters: [hostHeader],
      requestBody: { required: true, content: jsonContent(RememberInput) },
      responses: { '202': { description: 'Candidate accepted for review', content: jsonContent(Candidate) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '409': { description: 'Idempotency conflict, no trusted turn, or the no-retention turn rule' } },
    } },
    '/v1/candidates/{candidateId}': { get: {
      description: 'A persisted candidate and its submission receipt.',
      parameters: [hostHeader, { name: 'candidateId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
      responses: { '200': { description: 'Candidate and receipt', content: jsonContent(Candidate) }, '401': { description: 'Unauthorized' }, '404': { description: 'Candidate not found' } },
    } },
    '/v1/conflicts/{caseId}': { get: {
      description: 'Conflict case with evidence references and recorded decisions.',
      parameters: [{ name: 'caseId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
      responses: { '200': { description: 'Conflict case descriptor', content: jsonContent(ConflictDescriptor) }, '401': { description: 'Unauthorized' }, '404': { description: 'Conflict case not found' } },
    } },
    '/v1/conflicts/resolve': { post: {
      description: 'Operator-only conflict adjudication. Coexist requires an amended replacement candidate.',
      security: [{ operator: [] }],
      requestBody: { required: true, content: jsonContent(ConflictResolutionInput) },
      responses: { '200': { description: 'Adjudication recorded', content: jsonContent(Candidate) }, '401': { description: 'Operator credential required' }, '409': { description: 'Case state, CAS or replacement invalid' } },
    } },
    '/v1/review': { post: {
      description: 'Operator-only exception review: approve, reject or amend a candidate that the deterministic checks could not settle.',
      security: [{ operator: [] }],
      requestBody: { required: true, content: jsonContent(HumanReviewInput) },
      responses: { '200': { description: 'Recorded decision', content: jsonContent(Candidate) }, '401': { description: 'Operator credential required' }, '409': { description: 'Invalid state or unresolved conflict' } },
    } },
    '/v1/retry': { post: {
      description: 'Operator confirms the original writer is stopped; the retry still reconciles the Provider first.',
      security: [{ operator: [] }],
      requestBody: { required: true, content: jsonContent(RetryInput) },
      responses: { '202': { description: 'Write queued with the original stable write key', content: jsonContent(Candidate) }, '401': { description: 'Operator credential required' }, '409': { description: 'Candidate is not failed' } },
    } },
    '/v1/versions/cancel': { post: {
      description: 'Operator-only cancellation of an unpublished version operation. The Provider was not written.',
      security: [{ operator: [] }],
      requestBody: { required: true, content: jsonContent(CancelVersionInput) },
      responses: { '200': { description: 'Operation cancelled; candidate rejected', content: jsonContent(Candidate) }, '401': { description: 'Operator credential required' }, '409': { description: 'Operation already published' } },
    } },
    '/v1/memory-write-tasks/{taskId}/actions/{index}': {
      post: {
        description: 'Execute one action of an authorized write task. Trusted host code only; never registered as a model tool. The key (host, task, index) is stable, so a replay returns the latest receipt and the same key with a different payload is IDEMPOTENCY_CONFLICT.',
        parameters: [hostHeader, { name: 'taskId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }, { name: 'index', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } }],
        requestBody: { required: true, content: jsonContent(WriteTaskAction) },
        responses: { '200': { description: 'Action receipt', content: jsonContent(WriteTaskReceipt) }, '400': { description: 'Invalid plan' }, '401': { description: 'Unauthorized or no trusted turn' }, '404': { description: 'No such receipt for this host' }, '409': { description: 'VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, SYNC_QUEUED, SYNC_OUTCOME_UNKNOWN, TURN_NO_RETENTION, WORKSPACE_REQUIRED or the turn budget' } },
      },
      get: {
        description: 'Read the latest known receipt for one action. Only the initiating host sees it; any other host receives NOT_FOUND.',
        parameters: [hostHeader, { name: 'taskId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }, { name: 'index', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } }],
        responses: { '200': { description: 'Action receipt', content: jsonContent(WriteTaskReceipt) }, '401': { description: 'Unauthorized' }, '404': { description: 'Receipt not found for this host' } },
      },
    },
    '/v1/archive-distillations': { post: {
      description: 'Create one immutable distillation draft from a workspace archive. The Server re-checks the source version and content hash and records the draft for this host. Nothing is published.',
      parameters: [hostHeader],
      requestBody: { required: true, content: jsonContent(ArchiveDistillationCreate) },
      responses: { '201': { description: 'Draft', content: jsonContent(ArchiveDistillationRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '404': { description: 'Source archive not readable' }, '409': { description: 'VERSION_CONFLICT: the source changed' } },
    } },
    '/v1/archive-distillations/{draftId}': { get: {
      description: 'Read one distillation draft. Only the initiating host, and only while it may still read the source, sees it.',
      parameters: [hostHeader, { name: 'draftId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
      responses: { '200': { description: 'Draft', content: jsonContent(ArchiveDistillationRecord) }, '401': { description: 'Unauthorized' }, '404': { description: 'Draft not found for this host, or the source is no longer readable' } },
    } },

    '/v1/events': { post: {
      description: 'Host event intake: normalizes and persists one event with idempotent replay.',
      parameters: [hostHeader],
      requestBody: { required: true, content: jsonContent(HostEvent) },
      responses: { '200': { description: 'Stored, replayed or skipped event id' }, '400': { description: 'Invalid event' }, '409': { description: 'Same event id with a different payload' } },
    } },
    '/v1/session/close': { post: {
      description: 'Close one Host session so late results no longer bind to it.',
      parameters: [hostHeader],
      requestBody: { required: true, content: jsonContent(z.object({ sessionId: z.string().min(1).max(256) }).strict()) },
      responses: { '200': { description: 'Session closed' }, '400': { description: 'Invalid input' } },
    } },
    '/v1/idle-review/scan': { post: {
      description: 'Deterministic idle-review signal selection over completed turns. No model is called; the result is the durable evidence an isolated task Agent reads later.',
      parameters: [hostHeader],
      requestBody: { required: true, content: jsonContent(IdleReviewScanInput) },
      responses: { '200': { description: 'Selected signals, skipped counts and the new watermark', content: jsonContent(IdleReviewScanOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Missing host identity' } },
    } },
    '/v1/idle-review/signals': { get: {
      description: 'Signals already selected for one Host session, oldest turn first.',
      parameters: [hostHeader, { name: 'sessionId', in: 'query', required: true, schema: { type: 'string', maxLength: 256 } }],
      responses: { '200': { description: 'Stored signals', content: jsonContent(IdleReviewSignalsOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Missing host identity' } },
    } },
    '/v1/idle-review/runs': {
      get: {
        description: 'Idle-review runs for one Host session, newest first, with per-item results.',
        parameters: [hostHeader, { name: 'sessionId', in: 'query', required: true, schema: { type: 'string', maxLength: 256 } }],
        responses: { '200': { description: 'Runs', content: jsonContent(IdleReviewRunsOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Missing host identity' } },
      },
      post: {
        description: 'Start one idle-review run for a session and return the reserved signals. A session already running is refused; the Server does not call a model.',
        parameters: [hostHeader],
        requestBody: { required: true, content: jsonContent(IdleReviewRunStartInput) },
        responses: { '201': { description: 'Run and its signals', content: jsonContent(IdleReviewRunStartOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Missing host identity' }, '409': { description: 'A run is already running for this session' } },
      },
    },
    '/v1/idle-review/runs/{runId}/items': { post: {
      description: 'Append one item result to a running idle-review run. A finished or cancelled run refuses late items.',
      parameters: [hostHeader, { name: 'runId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
      requestBody: { required: true, content: jsonContent(IdleReviewRunItem) },
      responses: { '200': { description: 'Updated run', content: jsonContent(IdleReviewRun) }, '400': { description: 'Invalid input' }, '404': { description: 'Run not found' }, '409': { description: 'Run is not running' } },
    } },
    '/v1/idle-review/runs/{runId}/finish': { post: {
      description: 'Finish a running idle-review run. A failed or cancelled run releases its reserved signals so a retry sees them again.',
      parameters: [hostHeader, { name: 'runId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
      requestBody: { required: true, content: jsonContent(IdleReviewRunFinishInput) },
      responses: { '200': { description: 'Finished run', content: jsonContent(IdleReviewRun) }, '400': { description: 'Invalid input' }, '404': { description: 'Run not found' }, '409': { description: 'Run is already settled' } },
    } },
    '/v1/idle-review/pending': { get: {
      description: 'Sessions of this Host that still have signals no settled run consumed.',
      parameters: [hostHeader],
      responses: { '200': { description: 'Pending sessions', content: jsonContent(IdleReviewPendingOutput) }, '401': { description: 'Missing host identity' } },
    } },

    '/v1/diagnostics/embeddings': { get: {
      description: 'Official embedding coverage: whether the embedding service is reachable, whether the configured model is usable, how many insights carry a vector, and the recall mode that follows. `unknown` means the Provider interface could not answer.',
      parameters: [hostHeader],
      responses: { '200': { description: 'Embedding and recall diagnosis', content: jsonContent(EmbeddingDiagnostics) }, '401': { description: 'Missing host identity' } },
    } },
    '/v1/diagnostics/embeddings/backfill': { post: {
      description: 'Backfill missing embedding vectors with the Provider command. One job per kind runs at a time; the job row survives restarts and a killed run is marked interrupted on the next start.',
      parameters: [hostHeader],
      responses: { '202': { description: 'Backfill job started', content: jsonContent(DiagnosticJob) }, '401': { description: 'Missing host identity' }, '409': { description: 'A backfill is already running' } },
    } },
    '/v1/sync/status': { get: {
      description: 'Local sync state with the remote sync Server, per stream: cursor, last pull, last error, pending, unknown and unapplied counts.',
      security: [{ operator: [] }, { bearer: [] }],
      responses: { '200': { description: 'Local sync state', content: jsonContent(SyncStatusOutput) }, '401': { description: 'Unauthorized' } },
    } },
    '/v1/sync/refresh': { post: {
      description: 'Manual sync pass: resolve unknown submissions, push the outbox, pull and apply each readable stream. Overlapping passes are skipped rather than queued.',
      security: [{ operator: [] }, { bearer: [] }],
      responses: { '200': { description: 'Pass result', content: jsonContent(SyncRefreshOutput) }, '401': { description: 'Unauthorized' } },
    } },
  },
} as const;

export type OpenApiDocument = typeof openapi;
export const httpPaths = Object.keys(openapi.paths);
/** Explicit write-task and distillation schemas, re-exported for route tests. */
export const writeTaskSchemas = {
  formal: FormalMemoryTaskAction,
  rule: RuleTaskAction,
  archive: WorkspaceArchiveTaskAction,
  receipt: WriteTaskReceipt,
  distillation: ArchiveDistillationRecord,
  distillationCreate: ArchiveDistillationCreate,
  sessionWorkspace: SessionWorkspaceRecord,
  archiveRecord: ArchiveRecord,
  archiveSegment: ArchiveSegmentInput,
  archiveSegmentOutput: ArchiveSegmentOutput,
  workspaceRecord: WorkspaceRecord,
} as const;
