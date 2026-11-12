import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CandidateIdInput, ConflictIdInput, MemoryIdInput, RecallInput, RememberInput, publicError } from '../../../core/contracts/src/index.ts';
import type { MemoryApplication } from '../../../core/application/src/index.ts';

/**
 * Generic stdio MCP surface.
 *
 * These tools are the smallest set a host can offer when it has no native tool registration:
 * recall and read are reads, `remember` submits a candidate and never publishes. Rules and
 * archives are not here: a host that cannot bind a trusted session cannot choose a workspace,
 * and a candidate must not become a direct write.
 */
export type MemoryToolApplication = Pick<MemoryApplication, 'recall' | 'health' | 'remember' | 'candidateStatus' | 'readMemory' | 'readConflict' | 'acceptsCandidates'>;

/** The shared engineering-experience guidance every `remember` description quotes. */
export const ENGINEERING_EXPERIENCE_GUIDANCE = [
  '当本轮验证了一个非显然、能减少未来排查或返工、且可在其他工作区复用的工程结论时，主动考虑记录。',
  '先在剩余召回额度内核对是否已有同等结论，再选本轮最有价值的一条，写清适用条件、观察结果和可复用做法，并给出证据引用。本轮不留存时跳过。',
  '适合记录的是有可核对依据的诊断方法、工具版本差异、可复现的故障条件和验证过的解决办法；仓库特有路径、部署地址和项目交接信息留在工作区档案。',
  '单凭执行过一条命令、一次原因不明的成功、模型猜测或原始日志堆积不能作为新经验提交。',
].join('');

export function createMcpServer(app: MemoryToolApplication): McpServer {
  const server = new McpServer(
    { name: 'mnemoweave', version: '0.2.0' },
    { instructions: 'MnemoWeave 提供共享正式记忆的检索与候选提交。正式记忆由一个共享集合组成，读取不按工作区过滤；工作区档案与准则只通过提供了可信会话绑定的宿主入口访问。' },
  );
  server.registerTool('recall', { description: 'Recall over the shared formal-memory collection by semantic similarity. Read-only.', inputSchema: RecallInput }, async input => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await app.recall(input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
  });
  server.registerTool('provider_health', { description: 'Check configured Provider readiness' }, async () => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await app.health()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
  });
  if (app.acceptsCandidates) {
    server.registerTool('read_conflict', { description: 'Read conflict evidence references and operator decision history; cannot resolve a conflict.', inputSchema: ConflictIdInput }, async input => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await app.readConflict(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
    });
    server.registerTool('read_memory', { description: 'Read the current or a named historical published revision from the Provider and verify its hash.', inputSchema: MemoryIdInput }, async input => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await app.readMemory(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
    });
    server.registerTool('remember', { description: `Submit one immutable candidate for review; this does not publish formal memory or write the Provider. ${ENGINEERING_EXPERIENCE_GUIDANCE}`, inputSchema: RememberInput }, async input => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await app.remember(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
    });
    server.registerTool('candidate_status', { description: 'Read a persisted candidate and its submission receipt; not a Provider write receipt and never a publication.', inputSchema: CandidateIdInput }, async input => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await app.candidateStatus(input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
    });
  }
  return server;
}
