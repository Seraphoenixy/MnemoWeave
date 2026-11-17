import { randomUUID } from 'node:crypto'
import type { HostAgent } from '../support/dsh.ts'
import type { DocumentCapacityPlan, DocumentMutation, DocumentMutationResult, DocumentRecord, DocumentView } from 'dsh-mnemo-weave/source-documents/contracts'
import { sourceFailure, type SourceSession } from '../session/source-session.ts'
import type { CoordinatedDocumentResult, SubagentCounters } from '../contracts/protocol.ts'
import type { MnemonAgentRuntimeSource, MnemonRuntimeGraph } from './runtime.ts'
import type { ComposableMemoryTurn } from '../../core/turns.ts'

export interface DocumentWorkflowHost {
  readonly runtimeSource: MnemonAgentRuntimeSource
  readonly counters: SubagentCounters
  turnAuthority(agent: HostAgent, required: boolean): { context: ComposableMemoryTurn; graph: MnemonRuntimeGraph } | undefined
  sourceFor(parent: HostAgent, typeId: string): SourceSession
  writableSourceFor(parent: HostAgent, typeId: string, actionId: string): Promise<SourceSession>
}

export async function documentLocked(host: DocumentWorkflowHost, parent: HostAgent, request: DocumentMutation, signal: AbortSignal): Promise<CoordinatedDocumentResult> {
  const controller = await host.writableSourceFor(parent, 'documents', 'manage')
  const archivedDocumentIds: string[] = []
  let lastArchive: CoordinatedDocumentResult['maintenance']

  for (;;) {
    const plan = await controller.read<DocumentCapacityPlan>('capacity-plan', request, signal)
    if (plan.fits) break
    const candidate = plan.candidates.find(document => !archivedDocumentIds.includes(document.id))
    if (candidate === undefined) throw new Error('Document capacity exceeded with no archive candidate (' + plan.projected + ' > ' + plan.limit + ' bytes)')
    const archived = await archiveDocumentLocked(host, parent, candidate.id, signal)
    archivedDocumentIds.push(candidate.id)
    lastArchive = archived.maintenance
  }

  let result: DocumentMutationResult
  try {
    result = await documentCommit(host, parent, request, signal)
  } catch (error) {
    // A concurrent writer can invalidate the preflight. Retry once through
    // the same archive-before-eviction path without overwriting its revision.
    if (!sourceFailure<{ code: 'document-capacity'; candidates: DocumentRecord[] }>(error, 'document-capacity') || error.candidates.length === 0) throw error
    const archived = await archiveDocumentLocked(host, parent, error.candidates[0]!.id, signal)
    archivedDocumentIds.push(error.candidates[0]!.id)
    lastArchive = archived.maintenance
    result = await documentCommit(host, parent, request, signal)
  }
  if (archivedDocumentIds.length === 0 || lastArchive === undefined) return result
  return {
    ...result,
    maintenance: {
      ...lastArchive,
      archivedDocumentIds,
    },
  }
}

export async function archiveDocumentLocked(host: DocumentWorkflowHost, parent: HostAgent, id: string, signal: AbortSignal): Promise<CoordinatedDocumentResult> {
  signal.throwIfAborted()
  const graph = host.runtimeSource.forAgent(parent)
  const authority = host.turnAuthority(parent, false)
  const lease = graph.memoryComposition.acquire(authority?.context.view.runtimeGeneration)
  try {
    const controller = (await host.writableSourceFor(parent, 'documents', 'manage')).forGeneration(lease.generation)
    const document = await controller.read<DocumentView>('document', { id }, signal)
    if (document.status !== 'active') throw new Error('only active documents can be archived')
    return await archiveDocumentLocally(host.counters, controller, document, signal)
  } finally { lease.release() }
}

async function documentCommit(host: DocumentWorkflowHost, parent: HostAgent, request: DocumentMutation, signal: AbortSignal): Promise<DocumentMutationResult> {
  const source = host.sourceFor(parent, 'documents')
  if (host.turnAuthority(parent, false) === undefined) return source.mutate('mutate', request, signal)
  const receipt = await source.action('manage', request, offer => host.runtimeSource.config.writeEnabled && offer.authority === undefined, signal)
  return receipt.details as unknown as DocumentMutationResult
}

async function archiveDocumentLocally(counters: SubagentCounters, controller: SourceSession, document: DocumentView, signal: AbortSignal): Promise<CoordinatedDocumentResult> {
  signal.throwIfAborted()
  const summary = 'Archived workspace material.'
  const archived = await controller.mutate<DocumentMutationResult>('archive', { id: document.id, documentRevision: document.revision, summary, memoryBodyIds: [] }, signal)
  const runId = `host-${randomUUID()}`
  counters.documentArchives += 1
  counters.lastRunId = runId
  counters.lastOperation = 'document-archive'
  counters.lastAt = new Date().toISOString()
  return { ...archived, maintenance: { runId, provider: 'host', summary, memoryBodyIds: [], archivedDocumentIds: [document.id] } }
}
