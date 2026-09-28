import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb} from './helpers/ai-harness.mjs';
installAiHooks();
const {retrieveApprovedKnowledge,createAiBusinessDraft,transitionAiBusinessConfig}=await import('../lib/ai-business-configuration.ts');
const {knowledgeTokens,knowledgePassages}=await import('../lib/ai-knowledge-retrieval.ts');
const {stageMayaKnowledgeDrafts,aiKnowledgeCoverage}=await import('../lib/ai-knowledge-coverage.ts');
const {MAYA_KNOWLEDGE,seedMayaKnowledge}=await import('../lib/maya-knowledge-base.ts');
async function publish(db,key,content,visibility=['public']){
 const d=await createAiBusinessDraft(db,{entityType:'knowledge',payload:{sourceKey:key,title:key,contentText:content,visibilityScope:visibility},actorEmail:'maker@test.invalid'});
 for(const action of ['submit_review','approve','activate'])await transitionAiBusinessConfig(db,{entityType:'knowledge',entityId:d.id,action,actorEmail:action==='submit_review'?'maker@test.invalid':'checker@test.invalid'});
 return d.id;
}
test('retrieval returns the answer beyond 1600 characters rather than a document prefix',async t=>{
 const w=freshAiDb();t.after(()=>w.sqlite.close());
 const answer='Refund reviews use the purchased policy and verified payment state. No automatic approval or deadline is promised.';
 const id=await publish(w.db,'large_service_document',('Home grooming and training overview.\n\n').repeat(80)+'## Refund process\n\n'+answer);
 const result=await retrieveApprovedKnowledge(w.db,{query:'How are refunds reviewed?',visibilityScopes:['public']});
 assert.equal(result.results[0].id,id);assert.equal(result.results[0].content,answer);assert.ok(result.results[0].passage.start>1600);assert.equal(result.results[0].passage.completeParagraph,true);
});
test('Unicode scripts and known wording variants can retrieve approved content',async t=>{
 const w=freshAiDb();t.after(()=>w.sqlite.close());
 assert.deepEqual(knowledgeTokens('GST taxes'),['tax']);
 await publish(w.db,'hindi','ग्रूमिंग के बाद भुगतान की अनुमति कोट के अनुसार निर्धारित होती है।');
 const result=await retrieveApprovedKnowledge(w.db,{query:'ग्रूमिंग भुगतान',visibilityScopes:['public']});
 assert.equal(result.results[0].sourceKey,'hindi');
});
test('drafts retired future expired and private sources do not enter public answers',async t=>{
 const w=freshAiDb();t.after(()=>w.sqlite.close());
 await publish(w.db,'public','Refund review is governed.');await publish(w.db,'private','Refund secret payroll canary',['finance']);
 const future=await publish(w.db,'future','Refund unpublished future canary');const expired=await publish(w.db,'expired','Refund expired canary');
 w.sqlite.prepare('UPDATE ai_knowledge_source_versions SET effective_from=? WHERE id=?').run(Date.now()+100000,future);
 w.sqlite.prepare('UPDATE ai_knowledge_source_versions SET effective_to=? WHERE id=?').run(Date.now()-100000,expired);
 await createAiBusinessDraft(w.db,{entityType:'knowledge',payload:{sourceKey:'draft',title:'Refund draft',contentText:'Refund draft canary',visibilityScope:['public']},actorEmail:'maker@test.invalid'});
 const r=await retrieveApprovedKnowledge(w.db,{query:'refund',visibilityScopes:['public'],limit:10});assert.deepEqual(r.results.map(x=>x.sourceKey),['public']);assert.doesNotMatch(JSON.stringify(r),/canary/);
});
test('oversized single paragraphs are never silently cut into an authoritative partial policy',()=>{
 assert.equal(knowledgePassages('refund '.repeat(1000)).length,0);
});
test('library staging is draft-only, idempotent and does not claim 100 percent knowledge',async t=>{
 const w=freshAiDb();t.after(()=>w.sqlite.close());
 const first=await stageMayaKnowledgeDrafts(w.db,'founder@test.invalid');assert.equal(first.created,MAYA_KNOWLEDGE.length);assert.equal(first.activated,0);
 const second=await stageMayaKnowledgeDrafts(w.db,'founder@test.invalid');assert.equal(second.created,0);assert.equal(second.unchanged,MAYA_KNOWLEDGE.length);
 assert.equal((await retrieveApprovedKnowledge(w.db,{query:'refund',visibilityScopes:['public']})).results.length,0);
 const c=await aiKnowledgeCoverage(w.db);assert.equal(c.activeTopics,0);assert.equal(c.knowledgeComplete,false);assert.equal(c.customerReady,false);assert.equal(c.ownerDecisions.length,9);
});
test('even all active explanation articles cannot certify unresolved commercial facts or audio',async t=>{
 const w=freshAiDb();t.after(()=>w.sqlite.close());await seedMayaKnowledge(w.db,{maker:'maker@test.invalid',checker:'checker@test.invalid'});
 const c=await aiKnowledgeCoverage(w.db);assert.equal(c.activeTopicPercent,100);assert.equal(c.sourceMatchedTopics,MAYA_KNOWLEDGE.length);assert.equal(c.knowledgeComplete,false);assert.equal(c.audioAcceptance,'not_certified');
});


test('matching a headline must retain low-scoring restrictions in a short source',async t=>{
 const w=freshAiDb();t.after(()=>w.sqlite.close());
 const text='## Cancellation process\n\nCancellation requests can be submitted through the booking.\n\nExceptions: delivered services and purchased terms still apply. No automatic money return is promised.';
 await publish(w.db,'process',text);
 const result=await retrieveApprovedKnowledge(w.db,{query:'cancellation',visibilityScopes:['public']});
 assert.equal(result.results[0].content,text);assert.equal(result.results[0].passage.completeSource,true);
});

test('expired or private matching content does not hide a required new public review draft',async t=>{
 const w=freshAiDb();t.after(()=>w.sqlite.close());
 const entry=MAYA_KNOWLEDGE[0];
 const privateVersion=await createAiBusinessDraft(w.db,{entityType:'knowledge',payload:{...entry,sourceType:'policy',visibilityScope:['finance']},actorEmail:'maker@test.invalid'});
 await stageMayaKnowledgeDrafts(w.db,'maker@test.invalid');
 const publicRows=w.sqlite.prepare("SELECT * FROM ai_knowledge_source_versions WHERE source_key=? AND visibility_scope_json='[\"public\"]'").all(entry.sourceKey);
 assert.equal(publicRows.length,1);assert.equal(publicRows[0].status,'draft');
 w.sqlite.prepare('UPDATE ai_knowledge_source_versions SET effective_to=? WHERE id=?').run(Date.now()-1000,publicRows[0].id);
 const repeated=await stageMayaKnowledgeDrafts(w.db,'maker@test.invalid');assert.equal(repeated.created,1);
 assert.equal(w.sqlite.prepare('SELECT status FROM ai_knowledge_source_versions WHERE id=?').get(privateVersion.id).status,'draft');
});
