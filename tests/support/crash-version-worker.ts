// Test-only process boundary; never imported into the Server.
import {join} from 'node:path';
import {SqliteCandidates} from '../../packages/infrastructure/governance/src/index.ts';
import {MnemonCliProvider} from '../../packages/providers/mnemon/src/index.ts';
import {MemoryWorkflow} from '../../packages/core/application/src/workflow.ts';
import {VersionWorkflow} from '../../packages/core/application/src/version-workflow.ts';
async function stopAt(stage:string){if(process.env.FAULT_STAGE===stage){process.stdout.write(`COMMITTED_${stage}\n`);await new Promise<void>(()=>{});}}
class FaultProvider extends MnemonCliProvider{
  override async persistReviewed(content:string,key:string){const result=await super.persistReviewed(content,key);await stopAt('content');return result;}
  override async linkSupersedes(source:string,target:string,metadata:{operationId:string;reason:string;effectiveAt:string}){const result=await super.linkSupersedes(source,target,metadata);await stopAt('link');return result;}
}
const repo=new SqliteCandidates(join(process.env.MNEMOWEAVE_STATE_DIR!,'governance.db'));
const provider=new FaultProvider({binary:process.env.MNEMON_BINARY!,dataDir:process.env.MNEMON_DATA_DIR!,store:process.env.MNEMON_STORE!});
setInterval(()=>{},1000);
await new MemoryWorkflow(repo,provider,1000,new VersionWorkflow(repo,provider)).tick();
