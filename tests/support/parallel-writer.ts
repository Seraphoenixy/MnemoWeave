// Test-only multi-process writer: submits N candidates against a shared governance database.
import { join } from 'node:path';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import type { RememberRequest } from '../../packages/core/contracts/src/index.ts';

const [, , pathArg, keyPrefix, countArg, contentArg] = process.argv;
if (!pathArg || !keyPrefix || !countArg || contentArg === undefined) { process.stderr.write('usage: parallel-writer <dbPath> <keyPrefix> <count> <content>\n'); process.exit(2); }
const path = pathArg;
const count = Number(countArg);
const request = (index: number): RememberRequest => ({
  idempotencyKey: `${keyPrefix}-${String(index).padStart(4, '0')}`,
  content: `${contentArg} writer=${process.pid} index=${index}`,
  knowledgeType: 'Practice', tags: [], scope: 'project',
  provenance: { source: 'parallel-writer', sourceReference: `fixture:${process.pid}:${index}`, evidence: ['multi-process fixture'], verificationStatus: 'unverified', confidence: 0.5, applicability: 'hardening fixture', limitations: 'test only', lastVerified: null },
});
const repo = new SqliteCandidates(join(path));
try {
  let stored = 0;
  for (let index = 0; index < count; index++) { repo.submit(request(index)); stored++; }
  process.stdout.write(`${JSON.stringify({ pid: process.pid, stored })}\n`);
} finally { repo.close(); }
