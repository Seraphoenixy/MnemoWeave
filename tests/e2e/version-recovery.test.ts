import { testHostHeaders, awaitServerReady, TEST_OPERATOR } from '../support/server.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {RememberInput} from '../../packages/core/contracts/src/index.ts';
import type {CandidateRecord} from '../../packages/core/contracts/src/index.ts';
import {SqliteCandidates} from '../../packages/infrastructure/governance/src/index.ts';
import {MnemonCliProvider,createRunner} from '../../packages/providers/mnemon/src/index.ts';
import {MemoryApplication} from '../../packages/core/application/src/index.ts';
import {startServer,stopProcess,until} from '../support/server.ts';
import { mnemonBinary } from './mnemon-binary.ts';
import { tempDir } from '../support/temp.ts';

for(const stage of ['content','link'])test(`Actual kill after ${stage} commit preserves old publication, then recovers one directed replacement`,{timeout:45000},async()=>{
  await mkdir('work/e2e',{recursive:true});const root=await tempDir('version-recovery', `version-${stage}`);
  const env={MNEMON_BINARY:mnemonBinary(),MNEMON_DATA_DIR:join(root,'provider'),MNEMON_STORE:'recovery',MNEMOWEAVE_STATE_DIR:join(root,'state'),MNEMOWEAVE_PORT:'0',MNEMOWEAVE_TOKEN:'recovery-host-token-0123456789',MNEMOWEAVE_OPERATOR_TOKEN:'recovery-operator-token-987654321'};
  let server=await startServer(env);let fault:ReturnType<typeof spawn>|undefined;
  const headers=testHostHeaders(env.MNEMOWEAVE_TOKEN);const operator={...headers,authorization:`Bearer ${env.MNEMOWEAVE_OPERATOR_TOKEN}`};
  const get=async(id:string)=>await(await fetch(`${server.url}/v1/candidates/${id}`,{headers})).json() as CandidateRecord;
  const input=(key:string,content:string)=>RememberInput.parse({idempotencyKey:key,content,provenance:{source:'test',sourceReference:'test:recovery',evidence:['fixture'],verificationStatus:'unverified',confidence:0.5,applicability:'same recovery scope',limitations:'fixture',lastVerified:null}});
  const submit=async(body:unknown)=>{const response=await fetch(`${server.url}/v1/remember`,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,202);return await response.json() as CandidateRecord;};
  const approve=(id:string)=>fetch(`${server.url}/v1/review`,{method:'POST',headers:operator,body:JSON.stringify({candidateId:id,decision:'approve',reason:'Reviewed recovery fixture'})});
  try{
    const initial=await submit(input('recovery-base-001','MnemoWeave recovery fixture original design.'));await until(()=>get(initial.id),c=>c.status==='needs_review');assert.equal((await approve(initial.id)).status,200);const base=await until(()=>get(initial.id),c=>c.status==='persisted');
    const replacement=await submit({...input('recovery-new-001','MnemoWeave recovery fixture replacement design.'),change:{kind:'supersede',targetMemoryId:base.publication!.memoryId,expectedRevisionId:base.publication!.revisionId,effectiveAt:new Date().toISOString(),reason:'Reviewed replacement',evidence:['review fixture']}});
    await until(()=>get(replacement.id),c=>c.status==='needs_review');await stopProcess(server.child);server=await startServer({...env,MNEMOWEAVE_WORKER:'off'});assert.equal((await approve(replacement.id)).status,200);await stopProcess(server.child);
    fault=spawn(process.execPath,['tests/support/crash-version-worker.ts'],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...env,FAULT_STAGE:stage}});
    await new Promise<void>((done,fail)=>{const timer=setTimeout(()=>fail(new Error('Fault stage not reached')),10000);fault!.once('exit',code=>{clearTimeout(timer);fail(new Error(`Worker exited ${code}`));});fault!.stdout!.on('data',chunk=>{if(String(chunk).includes(`COMMITTED_${stage}`)){clearTimeout(timer);done();}});});
    await stopProcess(fault);fault=undefined;
    const repo=new SqliteCandidates(join(env.MNEMOWEAVE_STATE_DIR,'governance.db'));const provider=new MnemonCliProvider({binary:env.MNEMON_BINARY,dataDir:env.MNEMON_DATA_DIR,store:env.MNEMON_STORE});
    try{assert.equal(repo.catalog.get(base.publication!.memoryId).currentRevisionId,base.publication!.revisionId);assert.equal(repo.get(replacement.id).publication,undefined);const visible=await new MemoryApplication(provider,repo).recall({query:'MnemoWeave recovery fixture',limit:20});assert.ok(visible.memories.some(m=>m.content===base.request.content));assert.ok(!visible.memories.some(m=>m.content===replacement.request.content));}finally{repo.close();}
    const run=createRunner(env.MNEMON_BINARY);const status=()=>run(['--data-dir',env.MNEMON_DATA_DIR,'--store',env.MNEMON_STORE,'status']).then(text=>JSON.parse(text) as {total_insights:number;edge_count:number});const before=await status();assert.equal(before.total_insights,2);
    await new Promise(done=>setTimeout(done,1200));server=await startServer(env);
    const recovered=await until(()=>get(replacement.id),c=>c.status==='persisted');assert.ok(recovered.publication);assert.notEqual(recovered.publication.memoryId,base.publication!.memoryId);
    const after=await status();assert.equal(after.total_insights,2);if(stage==='link')assert.equal(after.edge_count,before.edge_count);
    const old=await(await fetch(`${server.url}/v1/memories/${base.publication!.memoryId}`,{headers})).json() as {state:string;content:string};assert.equal(old.state,'superseded');assert.equal(old.content,base.request.content);
  }finally{if(fault)await stopProcess(fault);await stopProcess(server.child);}
});
