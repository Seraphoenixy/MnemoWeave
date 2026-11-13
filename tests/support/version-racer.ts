// Test-only version race: two processes approve the same revise intent on one logical
// memory; exactly one may hold the durable business reservation (SYNC/state invariant 1).
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { RememberInput, MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';

const [, , dbPath, candidateKey, baseMemoryId, baseRevisionId] = process.argv;
if (!dbPath || !candidateKey || !baseMemoryId || !baseRevisionId) {
  process.stderr.write('usage: version-racer <dbPath> <candidateKey> <baseMemoryId> <baseRevisionId>\n');
  process.exit(2);
}
const repo = new SqliteCandidates(dbPath);
try {
  const input = RememberInput.parse({
    idempotencyKey: candidateKey, content: 'Racing second generation content.',
    tags: [],
    provenance: { source: 'version-racer', sourceReference: 'fixture:race'},
    change: { kind: 'revise', targetMemoryId: baseMemoryId, expectedRevisionId: baseRevisionId, effectiveAt: new Date().toISOString(), reason: 'racing revision', evidence: ['racer'] },
  });
  const candidate = repo.submit(input);
  repo.review(candidate.id, 'approve', 'racer', 'reservation race');
  process.stdout.write(`${JSON.stringify({ pid: process.pid, outcome: 'reserved' })}\n`);
  process.exit(0);
} catch (error) {
  const code = error instanceof MnemoWeaveError ? error.code : 'UNKNOWN';
  process.stdout.write(`${JSON.stringify({ pid: process.pid, outcome: 'rejected', code })}\n`);
  process.exit(3);
} finally { repo.close(); }
