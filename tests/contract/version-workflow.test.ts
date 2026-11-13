import {test} from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RememberInput, MnemoWeaveError} from '../../packages/core/contracts/src/index.ts';
import {SqliteCandidates} from '../../packages/infrastructure/governance/src/index.ts';
import {VersionWorkflow} from '../../packages/core/application/src/version-workflow.ts';
import type {VersionProvider} from '../../packages/core/application/src/version-ports.ts';
import {MemoryApplication} from '../../packages/core/application/src/index.ts';
import { tempDir } from '../support/temp.ts';

async function fixture(kind:'revise'|'supersede'='revise'){
  const root=await tempDir('version-workflow', 'version-fault');const path=join(root,'governance.db');const repo=new SqliteCandidates(path);
  const request=(key:string,content:string)=>RememberInput.parse({idempotencyKey:key,content,provenance:{source:'fixture',sourceReference:'version:test'}});
  const old=repo.submit(request('version-base-001','original immutable version'));repo.review(old.id,'approve','operator','fixture');repo.acquire('base-owner',90000);repo.finish(repo.claim('base-owner')!,{id:'base-provider',action:'added'},false);repo.release('base-owner');const base=repo.get(old.id).publication!;
  const input={...request('version-next-001','next immutable version'),change:{kind,targetMemoryId:base.memoryId,expectedRevisionId:base.revisionId,effectiveAt:new Date().toISOString(),reason:'reviewed evolution',evidence:['reviewed fixture']}};
  const candidate=repo.submit(input);repo.review(candidate.id,'approve','operator','fixture');
  const memories=new Map([['base-provider',old.request.content]]);let writes=0;let linkCalls=0;const edges=new Set<string>();
  const provider:VersionProvider={
    async health(){return{};},async recall(){return{memories:[...memories].map(([id,content])=>({id,content}))};},
    async readMemory(id){const content=memories.get(id);if(content===undefined)throw new Error('missing');return{id,content};},
    async inspectExact(content){return{complete:true,matches:[...memories].filter(([,c])=>c===content).map(([id,c])=>({id,content:c}))};},
    async verifyContent(id,content){return memories.get(id)===content;},
    async persistReviewed(content){const id=`new-${++writes}`;memories.set(id,content);return{id,action:'added'};},
    async linkSupersedes(source,target,meta){linkCalls++;edges.add(`${source}:${target}:${meta.operationId}`);return{};},
  };
  const claim=(owner:string)=>{repo.acquire(owner,90000);return repo.claim(owner)!;};
  const makeDue=()=>{const inject=new DatabaseSync(path);inject.exec('UPDATE governance_tasks SET next_at=0 WHERE state=\'failed\'');inject.close();};
  return{repo,path,old,base,input,candidate,request,provider,memories,edges,claim,makeDue,writes:()=>writes,linkCalls:()=>linkCalls};
}
test('Durable reservation blocks competing approval and expires neither on release nor process restart',async()=>{
  const f=await fixture();
  try{
    const competing=f.repo.submit({...f.input,idempotencyKey:'version-competing-001'});
    assert.throws(()=>f.repo.review(competing.id,'approve','operator','competing'));
    f.repo.close();const reopened=new SqliteCandidates(f.path);
    try{assert.throws(()=>reopened.review(competing.id,'approve','operator','still competing'));assert.equal(reopened.get(competing.id).reviews.length,0);}finally{reopened.close();}
  }catch(error){try{f.repo.close();}catch{}throw error;}
});
test('Final receipt failure rolls back pointer and relation publication; forward retry avoids extra content/link',async()=>{
  const f=await fixture('supersede');const inspect=new DatabaseSync(f.path);
  try{
    inspect.exec(`CREATE TRIGGER fail_final_receipt BEFORE INSERT ON governance_execution_receipts WHEN NEW.candidate_id='${f.candidate.id}' AND json_extract(NEW.result_json,'$.status')='persisted' BEGIN SELECT RAISE(ABORT,'publish receipt fault'); END;`);
    const job=f.claim('publish-owner');await new VersionWorkflow(f.repo,f.provider).execute(job);f.repo.release('publish-owner');
    assert.equal(f.repo.get(f.candidate.id).status,'failed');assert.equal(f.repo.catalog.get(f.base.memoryId).state,'active');assert.equal(f.repo.catalog.get(f.base.memoryId).currentRevisionId,f.base.revisionId);
    assert.equal(f.repo.get(f.candidate.id).publication,undefined);assert.equal(f.writes(),1);assert.equal(f.linkCalls(),1);
    const app=new MemoryApplication({...f.provider,async health(){return{ready:true,version:'0.2.13',capabilities:['recall']};}},f.repo);
    assert.deepEqual((await app.recall({query:'version'})).memories.map(m=>m.id),['base-provider']);
    inspect.exec('DROP TRIGGER fail_final_receipt');f.makeDue();const retry=f.claim('recover-owner');await new VersionWorkflow(f.repo,f.provider).execute(retry);f.repo.release('recover-owner');
    assert.equal(f.repo.get(f.candidate.id).status,'persisted');assert.equal(f.repo.catalog.get(f.base.memoryId).state,'superseded');assert.equal(f.writes(),1);assert.equal(f.linkCalls(),1);
  }finally{inspect.close();f.repo.close();}
});
test('Lost link response replays the immutable upsert intent and never the content',async()=>{
  const f=await fixture('supersede');let lost=true;const original=f.provider.linkSupersedes.bind(f.provider);
  f.provider.linkSupersedes=async(...args)=>{await original(...args);if(lost){lost=false;throw new Error('response lost');}return{};};
  try{
    const first=f.claim('lost-owner');await new VersionWorkflow(f.repo,f.provider).execute(first);f.repo.release('lost-owner');
    assert.equal(f.repo.get(f.candidate.id).status,'failed');assert.equal(f.repo.catalog.get(f.base.memoryId).state,'active');f.makeDue();
    const second=f.claim('retry-owner');await new VersionWorkflow(f.repo,f.provider).execute(second);f.repo.release('retry-owner');
    assert.equal(f.repo.get(f.candidate.id).status,'persisted');assert.equal(f.writes(),1);assert.equal(f.linkCalls(),2);assert.equal(f.edges.size,1);
  }finally{f.repo.close();}
});
test('Lost content response is reconciled before retry; no duplicate content appears',async()=>{
  const f=await fixture();const original=f.provider.persistReviewed.bind(f.provider);f.provider.persistReviewed=async(...args)=>{await original(...args);throw new Error('content response lost');};
  try{const first=f.claim('first');await new VersionWorkflow(f.repo,f.provider).execute(first);f.repo.release('first');f.makeDue();const second=f.claim('second');await new VersionWorkflow(f.repo,f.provider).execute(second);f.repo.release('second');assert.equal(f.repo.get(f.candidate.id).status,'persisted');assert.equal(f.writes(),1);}finally{f.repo.close();}
});
test('Changed baseline blocks dispatch and is held for human investigation rather than automatically retried',async()=>{
  const f=await fixture();f.memories.set('base-provider','externally changed');
  try{const job=f.claim('integrity-owner');await new VersionWorkflow(f.repo,f.provider).execute(job);f.repo.release('integrity-owner');const failed=f.repo.get(f.candidate.id);assert.equal(failed.status,'failed');assert.equal(failed.task!.next_at,null);assert.equal(f.writes(),0);assert.equal(f.repo.catalog.get(f.base.memoryId).currentRevisionId,f.base.revisionId);}finally{f.repo.close();}
});
test('Cancellation releases an unpublished reservation but is refused after an irreversible link',async()=>{
  const safe=await fixture();
  try{assert.equal(safe.repo.cancelVersion(safe.candidate.id,'operator','confirmed stopped').status,'rejected');const replacement=safe.repo.submit({...safe.input,idempotencyKey:'after-cancel-001'});assert.equal(safe.repo.review(replacement.id,'approve','operator','replacement').status,'approved');}finally{safe.repo.close();}
  const unsafe=await fixture('supersede');
  try{const job=unsafe.claim('owner');const op=unsafe.repo.versionOperation(job);op.checkpoint.link='invoking';unsafe.repo.versionCheckpoint(job,op.checkpoint);unsafe.repo.fail(job,'PROVIDER_TIMEOUT',false);unsafe.repo.release('owner');assert.throws(()=>unsafe.repo.cancelVersion(unsafe.candidate.id,'operator','cannot undo link'));assert.equal(unsafe.repo.get(unsafe.candidate.id).status,'failed');}finally{unsafe.repo.close();}
});
test('Approve interception covers unresolved conflict cases without relying on review records',async()=>{
  const f=await fixture();
  try{
    // Free the fixture's staged reservation so occupancy does not mask the conflict interception.
    f.repo.cancelVersion(f.candidate.id,'operator','setup: release the target memory');
    const conflicted=f.repo.submit({...f.request('conflict-case-001','conflicting conclusion'),change:{kind:'conflict',targetMemoryId:f.base.memoryId,expectedRevisionId:f.base.revisionId,effectiveAt:new Date().toISOString(),reason:'suspected factual conflict',evidence:['fixture evidence']}});
    assert.ok(f.repo.get(conflicted.id).conflictCaseId);
    const rival=f.repo.submit({...f.input,idempotencyKey:'rival-during-conflict-001'});
    // Rules-path human review records no semantic assessment: the review record alone carries no conflict evidence.
    f.repo.review(rival.id,'human','rules','operator inspection');
    const app=new MemoryApplication({...f.provider,async health(){return{ready:true,version:'0.2.13',capabilities:['health']};}},f.repo,f.repo);
    await assert.rejects(app.humanReview({candidateId:rival.id,decision:'approve',reason:'unrelated revision'},'operator'),(error:unknown)=>error instanceof MnemoWeaveError&&error.code==='REVIEW_REQUIRED');
    assert.equal(f.repo.get(rival.id).status,'needs_review');
    f.repo.review(conflicted.id,'reject','operator','case withdrawn');
    await app.humanReview({candidateId:rival.id,decision:'approve',reason:'case resolved'},'operator');
    assert.equal(f.repo.get(rival.id).status,'approved');
  }finally{f.repo.close();}
});
