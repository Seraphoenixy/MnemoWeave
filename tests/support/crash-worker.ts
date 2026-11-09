// Test-only fault injection. Never imported by production code.
import { join } from 'node:path';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MemoryWorkflow } from '../../packages/core/application/src/workflow.ts';
import { ChatModelGateway } from '../../packages/infrastructure/model-gateway/src/index.ts';
class StopAfterCommit extends MnemonCliProvider {
  override async persistReviewed(content: string, writeKey: string) {
    const result = await super.persistReviewed(content, writeKey);
    process.stdout.write('PROVIDER_COMMITTED\n');
    await new Promise<void>(() => {});
    return result;
  }
}
const repo = new SqliteCandidates(join(process.env.MNEMOWEAVE_STATE_DIR!, 'governance.db'));
const provider = new StopAfterCommit({ binary: process.env.MNEMON_BINARY!, dataDir: process.env.MNEMON_DATA_DIR!, store: process.env.MNEMON_STORE! });
const gateway = new ChatModelGateway({ routes: [{ url: process.env.MNEMOWEAVE_MODEL_URL!, model: process.env.MNEMOWEAVE_MODEL!, capabilities: ['semantic-assessment'] }] });
setInterval(() => {}, 1000); // Keep the faulted process alive until the test kills it.
await new MemoryWorkflow(repo, provider, gateway, 1000).tick();
