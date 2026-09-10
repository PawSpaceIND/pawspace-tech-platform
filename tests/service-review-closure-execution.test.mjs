import test from 'node:test';
import assert from 'node:assert/strict';
import { freshCountingD1 } from './helpers/d1-harness.mjs';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
installWorkersHooks('__REVIEW_CLOSURE_DB__');
const reviews = await import('../lib/service-review-governance.ts');
const cases = await import('../lib/unified-case-center.ts');
async function world(status = 'completed') {
 const ctx = freshCountingD1();
 const batch = ctx.db.batch;
 ctx.db.batch = async statements => { ctx.sqlite.exec('BEGIN'); try { const result = await batch(statements); ctx.sqlite.exec('COMMIT'); return result; } catch (error) { ctx.sqlite.exec('ROLLBACK'); throw error; } };
 globalThis.__REVIEW_CLOSURE_DB__ = ctx.db;
 ctx.sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT,status TEXT)");
 ctx.sqlite.prepare("INSERT INTO canonical_bookings VALUES ('B','C','P','grooming',?)").run(status);
 await reviews.ensureServiceReviewTables(ctx.db);
 await cases.ensureUnifiedCaseTables(ctx.db);
 ctx.sqlite.exec("INSERT INTO review_requests VALUES ('R','B','grooming','C','B:1','[]','[]','sent',1)");
 const policy = await cases.saveCasePolicy(ctx.db, {name:'Review recovery',caseType:'customer_complaint',severity:'high',firstResponseMinutes:15,resolutionMinutes:60,managerEscalationMinutes:30,effectiveFrom:1,actorId:'qa'});
 await cases.activateCasePolicy(ctx.db, {policyId:policy.id,approvalReference:'qa-policy',actorId:'qa'});
 return ctx;
}
for (const status of ['confirmed','in_progress','cancelled','refunded']) test(`reject review and request for ${status} booking`, async () => {
 const {db,sqlite} = await world(status);
 await assert.rejects(reviews.submitServiceReview(db,{requestId:'R',customerId:'C',stars:1}), /completed/);
 await assert.rejects(reviews.requestServiceReview(db,{bookingId:'B',customerId:'C',serviceCode:'grooming'}), /completed/);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM service_reviews').get().n,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM unified_cases').get().n,0);
});
for (const stars of [1,2,3,4,5]) test(`${stars}-star review creates exactly the required immediate recovery case`, async () => {
 const {db,sqlite} = await world();
 await reviews.submitServiceReview(db,{requestId:'R',customerId:'C',stars});
 const ticket = sqlite.prepare('SELECT * FROM unified_cases').get();
 assert.equal(Boolean(ticket),stars<=2);
 if(ticket) {assert.equal(ticket.booking_id,'B');assert.equal(ticket.customer_id,'C');assert.equal(ticket.provider_id,'P');assert.equal(ticket.owner_team,'customer_support');assert.equal(ticket.severity,'high');assert.ok(ticket.first_response_due_at>ticket.created_at);assert.ok(ticket.manager_escalation_due_at>ticket.first_response_due_at);}
 await assert.rejects(reviews.submitServiceReview(db,{requestId:'R',customerId:'C',stars}),/already/);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM service_reviews').get().n,1);
});
test('failure writing a low review rolls back its support case and audit event',async()=>{
 const {db,sqlite} = await world();
 sqlite.exec("CREATE TRIGGER reject_review BEFORE INSERT ON service_reviews BEGIN SELECT RAISE(ABORT,'injected review failure'); END");
 await assert.rejects(reviews.submitServiceReview(db,{requestId:'R',customerId:'C',stars:1}),/injected/);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM unified_cases').get().n,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM unified_case_events').get().n,0);
 assert.equal(sqlite.prepare("SELECT status FROM review_requests WHERE id='R'").get().status,'sent');
});
test('review request rejects customer or service mismatch',async()=>{
 const {db}=await world();
 await assert.rejects(reviews.requestServiceReview(db,{bookingId:'B',customerId:'other',serviceCode:'grooming'}),/match/);
 await assert.rejects(reviews.requestServiceReview(db,{bookingId:'B',customerId:'C',serviceCode:'taxi'}),/match/);
});

test('host low review creates an immediate case and aggregate rating reflects the stored review',async()=>{
 const {db,sqlite}=await world();
 const {submitHostReview,listHostReviews}=await import('../lib/host-reviews.ts');
 await submitHostReview(db,{hostProviderId:'P',customerId:'C',bookingId:'B',rating:2,title:'Needs attention',body:'The service needs follow-up from support.'});
 const ticket=sqlite.prepare("SELECT * FROM unified_cases WHERE source_type='host_review'").get();
 assert.equal(ticket.booking_id,'B');assert.equal(ticket.provider_id,'P');assert.equal(ticket.severity,'high');
 const {stats}=await listHostReviews(db,'P');assert.equal(stats.avgRating,2);assert.equal(stats.totalReviews,1);
});
