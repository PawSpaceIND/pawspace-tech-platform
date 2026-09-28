import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb} from './helpers/ai-harness.mjs';
installAiHooks();
const {AI_FOUNDER_BUSINESS_UPDATE:update,AI_FOUNDER_BUSINESS_DECISIONS:decisions,previewDaycareSplitReview}=await import('../lib/ai-founder-business-decisions.ts');
const {AI_KNOWLEDGE_OWNER_DECISIONS:open,AI_KNOWLEDGE_EXISTING_CODE_TERMS:existing}=await import('../lib/ai-knowledge-owner-decisions.ts');
const {MAYA_KNOWLEDGE:cards,seedMayaKnowledge}=await import('../lib/maya-knowledge-base.ts');
const {stageMayaKnowledgeDrafts,aiKnowledgeCoverage}=await import('../lib/ai-knowledge-coverage.ts');
const {createAiBusinessDraft,transitionAiBusinessConfig,retrieveApprovedKnowledge}=await import('../lib/ai-business-configuration.ts');
const {specialistSalesPrompt}=await import('../lib/voice-sales-specialists.ts');
const byService=service=>decisions.find(d=>d.service===service);
const card=key=>cards.find(c=>c.sourceKey===key).contentText;

test('six founder-confirmed rules are not live-activation or voice permissions',()=>{
 assert.equal(update.date,'2026-09-28');assert.equal(decisions.length,6);
 assert.deepEqual(decisions.map(d=>d.service),['grooming','grooming_subscriptions','daycare','walking','food','relocation']);
 assert.ok(decisions.every(d=>d.status==='founder_confirmed'));
 assert.equal(update.authorizations.liveKnowledgeActivation,false);
 assert.equal(update.authorizations.customerOrPaymentChanges,false);assert.equal(update.authorizations.handsetCall,false);
 assert.equal(update.authorizations.allVoicePaymentOptions,'not_newly_approved');
 assert.equal(update.authorizations.v2SourceAuthorityHierarchy,'not_newly_approved');
 assert.equal(update.publicationState,'reviewed_source_draft_not_activated');
});
for(const service of ['grooming','grooming_subscriptions'])test(service+': cash/UPI and payment timing are independent confirmed axes',()=>{
 const d=byService(service);assert.deepEqual(d.paymentTiming,['prepaid','pay_after_service']);assert.deepEqual(d.paymentMethods,['cash','upi']);assert.equal(d.paymentMethodsAreExhaustive,false);
 assert.equal(update.paymentTimingAndMethodAreSeparate,true);
});
test('subscription collection and credit activation remain unspecified',()=>{
 const d=byService('grooming_subscriptions');assert.equal(d.collectionBasis,'clarification_required');
 assert.equal(d.collectionMilestone,null);assert.equal(d.creditActivationRule,null);
 assert.equal(d.blockingQuestion,'grooming_subscription_collection');
 assert.match(card('maya_grooming_subscriptions'),/prepaid or pay-after-service/);
 assert.match(card('maya_grooming_subscriptions'),/per redeemed session or the entire pack/);
 assert.doesNotMatch(card('maya_grooming_subscriptions'),/subscriptions are prepaid packs/);
});
test('daycare has its own half/half deadline, never the overnight-night restriction',()=>{
 const d=byService('daycare');assert.deepEqual(d.paymentTiming,['prepaid','split']);
 assert.deepEqual(d.split,{atBookingPercent:50,balancePercent:50,balanceDueHoursBeforeStart:24,overnightLongerThanFourNightsRestrictionApplies:false});
 assert.equal(d.paymentMethods,null);assert.equal(d.under24HoursRule,'clarification_required');
});
for(const [label,bookedAt,status]of [
 ['more than 24 hours','2026-09-29T10:00:00+05:30','reviewed_split_terms'],
 ['exactly 24 hours','2026-09-30T10:00:00+05:30','reviewed_split_terms'],
 ['one second inside the deadline','2026-09-30T10:00:01+05:30','founder_clarification_required'],
 ['same-day booking','2026-10-01T09:00:00+05:30','founder_clarification_required']
])test('daycare read-only boundary: '+label,()=>{
 const result=previewDaycareSplitReview({bookedAt,startsAt:'2026-10-01T10:00:00+05:30'});
 assert.equal(result.status,status);assert.equal(result.balanceDueAt,'2026-09-30T04:30:00.000Z');
 assert.equal(result.executionAuthorized,false);assert.equal(result.reviewOnly,true);
 assert.equal(result.fullPrepaidRequired,null,'do not invent a mandatory short-notice rule');
 assert.equal(result.unresolvedQuestion,status==='founder_clarification_required'?'daycare_under_24h':null);
});
test('daycare review requires a future exact instant and timezone, not a guessed calendar date',()=>{
 for(const bookedAt of ['2026-09-30','2026-09-30T10:00:00','invalid','2026-02-30T10:00:00+05:30','2026-02-29T10:00:00+05:30','2026-09-30T24:00:00+05:30','2026-10-01T10:00:00+05:30'])assert.throws(()=>previewDaycareSplitReview({bookedAt,startsAt:'2026-10-01T10:00:00+05:30'}));
});
test('walking is upfront-only for one-time, subscriptions and renewals; food is prepaid-only',()=>{
 assert.deepEqual(byService('walking').paymentTiming,['prepaid']);assert.deepEqual(byService('walking').appliesTo,['one_time','subscription','renewal']);
 assert.match(byService('walking').supersedes,/pay-after-service UAT/);
 assert.deepEqual(byService('food').paymentTiming,['prepaid']);
 for(const s of ['daycare','walking','food'])assert.equal(byService(s).paymentMethods,null,'do not copy grooming methods to '+s);
});
test('relocation is enquiry-only without instant booking or payment collection',()=>{
 const d=byService('relocation');assert.equal(d.bookingMode,'enquiry_only');assert.equal(d.instantBookingAllowed,false);assert.equal(d.paymentCollectionAllowed,false);
 assert.match(card('maya_relocation'),/enquiry only/);assert.match(card('maya_relocation'),/Do not offer instant booking, collect payment/);
});
test('open register separates two implementation questions, eight commercial groups and two other approvals',()=>{
 assert.equal(open.length,12);assert.equal(new Set(open.map(x=>x.id)).size,open.length);
 assert.deepEqual(open.filter(x=>x.category==='implementation_clarification').map(x=>x.id),['daycare_under_24h','grooming_subscription_collection']);
 assert.equal(open.filter(x=>x.category==='commercial_policy').length,8);
 assert.deepEqual(open.filter(x=>x.category==='separate_authorization').map(x=>x.id),['ai_voice_payment_access','v2_source_authority_hierarchy']);
 assert.equal(existing.status,'existing_code_unchanged_not_new_approval');
 assert.deepEqual(existing.dogTraining,{upfrontPercent:50,balanceScheduledFor:'final_session',extraPercentPerAdditionalDog:60});
});
test('specialist explanatory copy no longer labels every subscription prepaid but checkout permissions remain',()=>{
 const prompt=specialistSalesPrompt('grooming');assert.doesNotMatch(prompt,/actual prepaid subscription alternative/);
 assert.match(prompt,/Do not describe all subscriptions as prepaid-only/);
 assert.match(prompt,/booking.paymentMode to prepaid/,'this revision does not grant new action permissions');
});
test('staging the revised library cannot replace or activate an existing live knowledge version',async t=>{
 const w=freshAiDb();t.after(()=>w.sqlite.close());
 const old=await createAiBusinessDraft(w.db,{entityType:'knowledge',payload:{sourceKey:'maya_grooming_subscriptions',title:'Historical reviewed terms',contentText:'Historical version remains until an explicit activation.',sourceType:'policy',visibilityScope:['public']},actorEmail:'prior-maker@test.invalid'});
 for(const action of ['submit_review','approve','activate'])await transitionAiBusinessConfig(w.db,{entityType:'knowledge',entityId:old.id,action,actorEmail:'prior-checker@test.invalid'});
 const before=w.sqlite.prepare("SELECT * FROM ai_knowledge_source_versions WHERE id=?").get(old.id);
 const first=await stageMayaKnowledgeDrafts(w.db,'founder-review@test.invalid');assert.equal(first.activated,0);assert.equal(first.customerFacingChanged,false);
 assert.deepEqual(w.sqlite.prepare("SELECT * FROM ai_knowledge_source_versions WHERE id=?").get(old.id),before);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM ai_knowledge_source_versions WHERE status='active'").get().n,1);
 assert.equal((await stageMayaKnowledgeDrafts(w.db,'founder-review@test.invalid')).created,0);
 const c=await aiKnowledgeCoverage(w.db);assert.equal(c.confirmedBusinessDecisions.length,6);assert.equal(c.implementationQuestions.length,2);assert.equal(c.separateAuthorizations.length,2);
 assert.equal(c.knowledgeComplete,false);assert.equal(c.customerReady,false);assert.equal(c.audioAcceptance,'not_certified');
 assert.equal(c.ownerDecisionStatus,'partially_confirmed_review_required');
 assert.equal(c.founderUpdate.authorizations.liveKnowledgeActivation,false);
});
// These are local SQLite retrieval checks, not live-model or live-audio results.
test('reviewed founder cards are retrievable only after an isolated in-memory review lifecycle',async t=>{
 const w=freshAiDb();t.after(()=>w.sqlite.close());
 await stageMayaKnowledgeDrafts(w.db,'maker@test.invalid');
 assert.equal((await retrieveApprovedKnowledge(w.db,{query:'daycare split balance payment',visibilityScopes:['public']})).results.length,0);
 await seedMayaKnowledge(w.db,{maker:'local-test-maker@test.invalid',checker:'local-test-checker@test.invalid'});
 for(const [query,key,pattern]of [
 ['grooming prepaid cash UPI after service','maya_grooming_payment_timing',/prepaid and pay-after-service/],
 ['grooming subscriptions collection entire pack redeemed session','maya_grooming_subscriptions',/awaiting founder clarification/],
 ['daycare split payment 24 hour balance deadline','maya_daycare_payment_timing',/50% at booking/],
 ['walking upfront one-time subscription renewal','maya_walking_payment_timing',/all prepaid/],
 ['food prepaid payment','maya_food_payment_timing',/Food is prepaid only/],
 ['relocation instant booking payment enquiry','maya_relocation_enquiry_only',/Do not offer instant booking/]
 ]){
  const found=await retrieveApprovedKnowledge(w.db,{query,visibilityScopes:['public']});
  const result=found.results.find(r=>r.sourceKey===key);assert.ok(result,query+' => '+found.results.map(r=>r.sourceKey).join(','));assert.match(result.content,pattern);
 }
});

test('five audio cases remain unchanged and are not mislabelled as executed',()=>{
 const fixture=JSON.parse(fs.readFileSync('tests/fixtures/ai-founder-business-acceptance.json','utf8'));
 assert.equal(fixture.status,'not_run_on_this_revision');assert.equal(fixture.results,null);
 assert.equal(fixture.originalFiveScenarios.length,5);assert.equal(fixture.originalFiveScenarios.reduce((n,x)=>n+x.questions.length,0),20);
 assert.equal(fixture.originalFiveScenarios[4].expectedHandoffAt,4);
 assert.match(fixture.originalFiveScenarios[3].questions[3],/^Do not issue a refund/);
 assert.match(fixture.originalFiveScenarios[4].questions[3],/Do not call my number or send any message/);
 assert.equal(fixture.additionalFounderDecisionProbes.length,9);
 assert.equal(fixture.handsetCallAuthorized,false);assert.equal(fixture.liveKnowledgeActivationAuthorized,false);assert.equal(fixture.customerOrPaymentChangesAuthorized,false);
});

test('human review draft mirrors the corresponding code cards without publishing them',()=>{
 const document=fs.readFileSync('docs/ai/REVIEWED_KNOWLEDGE_FOUNDER_20260928.md','utf8');
 for(const key of ['maya_payment','maya_payment_modes','maya_grooming_payment_timing','maya_grooming_subscriptions','maya_daycare_payment_timing','maya_walking','maya_walking_payment_timing','maya_fresh_food','maya_food_payment_timing','maya_relocation','maya_relocation_documents','maya_relocation_enquiry_only'])assert.ok(document.includes(card(key)),key);
 assert.match(document,/Draft for review; not activated/);
});
