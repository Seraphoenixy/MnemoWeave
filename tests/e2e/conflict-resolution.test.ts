import { testHostHeaders, awaitServerReady, TEST_OPERATOR } from '../support/server.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {RememberInput} from '../../packages/core/contracts/src/index.ts';
import type {CandidateRecord,ConflictRecord} from '../../packages/core/contracts/src/index.ts';
import {startServer,stopProcess,until} from '../support/server.ts';
import { mnemonBinary } from './mnemon-binary.ts';

test('Real conflict decisions preserve history: keep, uncertain, revise, supersede and scope-qualified coexist', {timeout:90000},async()=>{
  await mkdir('work/e2e',{recursive:true});const root=await mkdtemp(resolve('work/e2e/conflicts-'));
  const env={MNEMON_BINARY:mnemonBinary(),MNEMON_DATA_DIR:join(root,'provider'),MNEMON_STORE:'conflicts',MNEMOWEAVE_STATE_DIR:join(root,'state'),MNEMOWEAVE_PORT:'0',MNEMOWEAVE_TOKEN:'conflict-host-token-0123456789',MNEMOWEAVE_OPERATOR_TOKEN:'conflict-operator-token-987654321'};
  let server=await startServer(env);
  const headers=testHostHeaders(env.MNEMOWEAVE_TOKEN);const operator={...headers,authorization:`Bearer ${env.MNEMOWEAVE_OPERATOR_TOKEN}`};
  const request=(key:string,text:string)=>RememberInput.parse({idempotencyKey:key,content:text,knowledgeType:'Practice',provenance:{source:'test',sourceReference:'fixture:conflict',evidence:['isolated fixture'],verificationStatus:'unverified',confidence:0.5,applicability:'same ARM project fixture',limitations:'not verified knowledge',lastVerified:null}});
  const submit=async(body:unknown)=>{const r=await fetch(`${server.url}/v1/remember`,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,202);return await r.json() as CandidateRecord;};
  const get=async(id:string)=>await(await fetch(`${server.url}/v1/candidates/${id}`,{headers})).json() as CandidateRecord;
  const publish=async(body:unknown)=>{const c=await submit(body);await until(()=>get(c.id),v=>v.status==='needs_review');const r=await fetch(`${server.url}/v1/review`,{method:'POST',headers:operator,body:JSON.stringify({candidateId:c.id,decision:'approve',reason:'Operator evaluated isolated fixture'})});assert.equal(r.status,200);return until(()=>get(c.id),v=>v.status==='persisted');};
  const read=async(id:string,revisionId?:string)=>await(await fetch(`${server.url}/v1/memories/${id}${revisionId?`?revisionId=${revisionId}`:''}`,{headers})).json() as {state:string;content:string;currentRevisionId:string;revisions:{id:string}[]};
  const caseRead=async(id:string)=>await(await fetch(`${server.url}/v1/conflicts/${id}`,{headers})).json() as ConflictRecord;
  try{
    let savedCaseId='';
    for(const decision of ['keep_existing','unverified','revise','supersede','coexist'] as const){
      const initial=await publish(request(`conflict-base-${decision}`,`MnemoWeave conflict ${decision}: original claim.`));const base=initial.publication!;
      const originalRequest={...request(`conflict-new-${decision}`,`MnemoWeave conflict ${decision}: conflicting claim.`),change:{kind:'conflict',targetMemoryId:base.memoryId,expectedRevisionId:base.revisionId,effectiveAt:new Date().toISOString(),reason:'Same conditions but contradictory conclusion',evidence:['contradictory fixture evidence']}};
      const candidate=await submit(originalRequest);await until(()=>get(candidate.id),v=>v.status==='needs_review');
      assert.ok(candidate.conflictCaseId);const caseId=candidate.conflictCaseId;savedCaseId=caseId;
      assert.equal((await caseRead(caseId)).state,'open');
      const attempted=await fetch(`${server.url}/v1/review`,{method:'POST',headers:operator,body:JSON.stringify({candidateId:candidate.id,decision:'approve',reason:'Cannot bypass conflict resolution'})});assert.equal(attempted.status,409);
      const body:{caseId:string;decision:string;reason:string;evidence:string[];replacement?:unknown}={caseId,decision,reason:'Operator compared scope and evidence',evidence:['review fixture result']};
      if(decision==='coexist'){
        const amended=request('conflict-coexist-qualified','MnemoWeave conflict coexist: both conclusions hold in distinct environments.');amended.provenance.applicability='PowerPC fixture environment';
        body.replacement={...amended,change:{...originalRequest.change,kind:'coexist',effectiveAt:new Date().toISOString(),reason:'Both true under explicitly distinct platforms'}};
      }
      const denied=await fetch(`${server.url}/v1/conflicts/resolve`,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(denied.status,401);
      const response=await fetch(`${server.url}/v1/conflicts/resolve`,{method:'POST',headers:operator,body:JSON.stringify(body)});assert.equal(response.status,200);const result=await response.json() as CandidateRecord;
      if(decision==='keep_existing'){
        assert.equal(result.status,'rejected');assert.equal((await read(base.memoryId)).content,initial.request.content);assert.equal((await caseRead(caseId)).state,'resolved');
      }else if(decision==='unverified'){
        assert.equal(result.status,'needs_review');assert.equal((await read(base.memoryId)).state,'unverified');assert.equal((await caseRead(caseId)).state,'unverified');
        const recalled=await(await fetch(`${server.url}/v1/recall`,{method:'POST',headers,body:JSON.stringify({query:'MnemoWeave conflict unverified',limit:20})})).json() as {memories:{content:string}[]};assert.ok(!recalled.memories.some(m=>m.content===initial.request.content));
      }else if(decision==='coexist'){
        await until(()=>get(result.id),v=>v.status==='needs_review');const approved=await fetch(`${server.url}/v1/review`,{method:'POST',headers:operator,body:JSON.stringify({candidateId:result.id,decision:'approve',reason:'Both scopes now explicit'})});assert.equal(approved.status,200);
        const persisted=await until(()=>get(result.id),v=>v.status==='persisted');assert.equal((await read(base.memoryId)).state,'active');assert.equal((await read(persisted.publication!.memoryId)).state,'active');assert.equal((await caseRead(caseId)).state,'resolved');
      }else{
        const persisted=await until(()=>get(candidate.id),v=>v.status==='persisted');
        assert.equal((await caseRead(caseId)).state,'resolved');
        if(decision==='revise'){assert.equal(persisted.publication!.memoryId,base.memoryId);assert.equal((await read(base.memoryId)).revisions.length,2);}
        else{assert.notEqual(persisted.publication!.memoryId,base.memoryId);assert.equal((await read(base.memoryId)).state,'superseded');}
      }
      assert.equal((await read(base.memoryId,base.revisionId)).content,initial.request.content);
      assert.equal((await caseRead(caseId)).decisions.length,1);
    }
    await stopProcess(server.child);server=await startServer(env);assert.equal((await caseRead(savedCaseId)).state,'resolved');
  }finally{await stopProcess(server.child);}
});
