import { CAPTURE_GUIDANCE } from '../../../core/application/src/runtime.ts';
import { RuntimeContextInput, ViewRequest } from '../../../core/contracts/src/index.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RecallInput, RememberInput, CandidateIdInput, MemoryIdInput,ConflictIdInput, publicError } from '../../../core/contracts/src/index.ts';
import type { MemoryApplication } from '../../../core/application/src/index.ts';

export type MemoryToolApplication = Pick<MemoryApplication, 'recall' | 'health' | 'remember' | 'candidateStatus' | 'readMemory' | 'readConflict' | 'acceptsCandidates'> & { runtimeContext?: (input: unknown) => Promise<unknown>; memoryView?: (input: unknown) => Promise<unknown> };
export function createMcpServer(app: MemoryToolApplication): McpServer {
  const server = new McpServer({ name: 'mnemoweave', version: '0.1.0' }, { instructions: CAPTURE_GUIDANCE });
  server.registerTool('recall', { description: 'Recall memory through MnemoWeave Application Core', inputSchema: RecallInput }, async input => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await app.recall(input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
  });
  server.registerTool('provider_health', { description: 'Check configured Provider readiness' }, async () => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await app.health()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
  });
  if (app.acceptsCandidates) {
    server.registerTool('read_conflict',{description:'Read conflict evidence references and operator decision history; cannot resolve a conflict.',inputSchema:ConflictIdInput},async input=>{
      try{return{content:[{type:'text',text:JSON.stringify(await app.readConflict(input))}]};}
      catch(error){return{isError:true,content:[{type:'text',text:JSON.stringify(publicError(error))}]};}
    });
    server.registerTool('read_memory', { description: 'Read current or historical published revision from Provider and verify its hash. Returns logical metadata and actual Provider text.', inputSchema: MemoryIdInput }, async input => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await app.readMemory(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
    });
    server.registerTool('remember', { description: 'Submit an immutable candidate for review. Does not write formal Provider memory.', inputSchema: RememberInput }, async input => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await app.remember(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
    });
    server.registerTool('candidate_status', { description: 'Read a persisted candidate and its submission receipt; not a Provider write receipt.', inputSchema: CandidateIdInput }, async input => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await app.candidateStatus(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
    });
  }
  if (app.runtimeContext) server.registerTool('runtime_context', { description: 'Read or explicitly update bounded task context for this Host session. This never publishes formal knowledge.', inputSchema: RuntimeContextInput }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await app.runtimeContext!(input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(publicError(error)) }] }; }
  });
  if (app.memoryView) server.registerTool('memory_view', { description: 'Assemble authorized resident memory and current session projection. Supply the current sessionId.', inputSchema: ViewRequest }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await app.memoryView!(input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(publicError(error)) }] }; }
  });
  return server;
}
