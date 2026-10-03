import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { freshSqlite, makeD1 } from './helpers/taxi-harness.mjs';
installWorkersHooks('__COMPANY_COMPLIANCE_READINESS_DB__', '__COMPANY_COMPLIANCE_READINESS_ENV__');
const store = await import('../lib/company-compliance/store.ts');
const route = await import('../app/api/company-compliance-drafts/route.ts');
const { ensureSecurityTables } = await import('../lib/server-auth.ts');
const { FACT_KEYS } = await import('../lib/company-compliance/readiness-contract.ts');
const { checksum } = await import('../lib/company-compliance/workflow.ts');
const ORIGIN = 'https://compliance.pawspace.test';
const ENTITY = 'fixture-IN', MAKER = 'fixture-finance@pawspace.test', CHECKER = 'fixture-checker@pawspace.test', VIEWER = 'fixture-viewer@pawspace.test';
// Synthetic fixtures only: no real company facts, directors, obligations or sources.
const fullFacts = (unknown = []) => Object.fromEntries(FACT_KEYS.map(key => [key, unknown.includes(key) ? { state: 'unknown' } : { state: 'provided', value: `SYNTHETIC ${key}`, sourceReference: `fixture/${key}` }]));
const requirement = { entityId: ENTITY, id: 'req-1', version: 1, area: 'other', title: 'SYNTHETIC requirement', obligationSummary: 'SYNTHETIC text; not a legal determination.', source: { authority: 'SYNTHETIC authority', url: 'https://fixture.gov.in/synthetic', publishedOn: '2026-01-01', effectiveFrom: '2026-01-01' }, applicabilityFactKeys: ['cin', 'pan'] };
const evidence = { kind: 'official_document', reference: 'fixture/evidence', sourceUrl: 'https://fixture.gov.in/synthetic-notification', quotedText: 'SYNTHETIC quoted text retained from the fixture source.' };
async function world() {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__COMPANY_COMPLIANCE_READINESS_DB__ = db;
  globalThis.__COMPANY_COMPLIANCE_READINESS_ENV__ = { COMPANY_COMPLIANCE_DRAFTS_ENABLED: 'true' };
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const [id, email, role] of [['finance', MAKER, 'finance'], ['manager', 'fixture-manager@pawspace.test', 'manager'], ['checker', CHECKER, 'finance'], ['viewer', VIEWER, 'finance']]) sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(id, email, id, role, now, now);
  sqlite.exec('CREATE TABLE finance_entities(id TEXT PRIMARY KEY,legal_name TEXT,country_code TEXT,status TEXT,secret_credentials TEXT)');
  sqlite.prepare('INSERT INTO finance_entities VALUES (?,?,?,?,?)').run(ENTITY, 'SYNTHETIC Company', 'IN', 'active', 'DO-NOT-EXPOSE-SYNTHETIC-SECRET');
  await store.ensureDraftTables(db);
  for (const [principal, role] of [[MAKER, 'maker'], [CHECKER, 'checker'], [VIEWER, 'viewer']]) sqlite.prepare('INSERT INTO company_compliance_entity_grants VALUES (?,?,?,?,?,?,?)').run(ENTITY, principal, role, 'active', new Date(Date.now() + 86400000).toISOString(), 'fixture-access-owner', 'fixture/grant');
  return { sqlite, db };
}
const tables = sqlite => sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'company_compliance_%'").get().n;
const get = (email = MAKER, entityId = ENTITY) => route.GET(new Request(`${ORIGIN}/api/company-compliance-drafts?entityId=${entityId}`, { headers: email ? { 'oai-authenticated-user-email': email } : {} }));
const post = (input, { email = MAKER, origin = ORIGIN, entityId = ENTITY } = {}) => route.POST(new Request(`${ORIGIN}/api/company-compliance-drafts?entityId=${entityId}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(email ? { 'oai-authenticated-user-email': email } : {}) }, body: JSON.stringify(input) }));
const data = async response => (await response.json()).data;

test('readiness view rides the existing authenticated, gated, grant-scoped GET and creates no schema', async () => {
  const { sqlite } = await world();
  assert.ok((await get(null)).status >= 400);
  assert.equal((await get('fixture-manager@pawspace.test')).status, 403);
  assert.equal((await get(MAKER, 'other-entity')).status, 403);
  globalThis.__COMPANY_COMPLIANCE_READINESS_ENV__ = {};
  assert.equal((await get()).status, 404);
  globalThis.__COMPANY_COMPLIANCE_READINESS_ENV__ = { COMPANY_COMPLIANCE_DRAFTS_ENABLED: 'true' };
  const view = await data(await get(VIEWER));
  assert.deepEqual([view.readiness.mode, view.readiness.intake, view.readiness.requirements, view.readiness.factKeys.length], ['draft_only', null, [], FACT_KEYS.length]);
  assert.equal(view.master, null, 'existing master view preserved');
  assert.doesNotMatch(JSON.stringify(view), /DO-NOT-EXPOSE|secret_credentials/);
  assert.equal(tables(sqlite), 6, 'GET never creates the readiness tables');
});

test('entity roles gate the new actions: viewers cannot write, makers cannot review, checkers cannot record intake; cross-origin and unknown actions are refused', async () => {
  const { sqlite } = await world();
  const intake = { action: 'record_intake', intake: { entityId: ENTITY, facts: fullFacts(['cin']) }, expectedVersion: 0 };
  assert.equal((await post(intake, { email: VIEWER })).status, 403);
  assert.equal((await post(intake, { email: CHECKER })).status, 403);
  assert.equal((await post(intake, { origin: 'https://evil.test' })).status, 403);
  assert.equal(tables(sqlite), 6, 'refused writes create nothing');
  const saved = await post(intake);
  assert.equal(saved.status, 201); assert.deepEqual(await data(saved), { version: 1, unknownFacts: ['cin'], mode: 'draft_only' });
  assert.equal(tables(sqlite), 7, 'intake mutation creates only its own table');
  assert.equal((await post({ action: 'propose_requirement', requirement }, { email: VIEWER })).status, 403);
  assert.equal((await post({ action: 'review_requirement', requirementId: 'req-1', version: 1, expectedSequence: 1, review: {} }, { email: MAKER })).status, 403);
  assert.equal((await post({ action: 'readiness_override' })).status, 400);
  assert.equal((await post({ action: 'record_intake', intake: { entityId: 'other', facts: fullFacts() }, expectedVersion: 1 })).status, 400);
  assert.equal((await post({ action: 'record_intake', intake: { entityId: ENTITY, facts: fullFacts() }, expectedVersion: 0 })).status, 409, 'stale intake version');
});

test('full flow through the actual route: identity comes from sign-in, self-review is refused, verification is internal readiness only, and a later intake or supersession invalidates it', async () => {
  const { sqlite } = await world();
  assert.equal((await post({ action: 'record_intake', intake: { entityId: ENTITY, facts: fullFacts() }, expectedVersion: 0 })).status, 201);
  const proposed = await post({ action: 'propose_requirement', requirement });
  assert.equal(proposed.status, 201); const record = await data(proposed);
  assert.equal((await post({ action: 'attach_requirement_evidence', requirementId: 'req-1', version: 1, evidence: { ...evidence, quotedText: 'x'.repeat(4001) } })).status, 400);
  assert.equal((await post({ action: 'attach_requirement_evidence', requirementId: 'req-1', version: 1, evidence: { ...evidence, sourceUrl: 'https://fixture.example.com/' } })).status, 400);
  const attached = await data(await post({ action: 'attach_requirement_evidence', requirementId: 'req-1', version: 1, evidence: { ...evidence, documentChecksum: 'caller-typed' } }));
  assert.equal(attached.documentChecksum, await checksum(evidence.quotedText));
  const review = { outcome: 'verified', reference: 'fixture/review', requirementChecksum: record.checksum, evidenceSequence: attached.evidenceSequence, evidenceChecksum: attached.documentChecksum, intakeVersion: 1, humanSourceReview: true };
  const body = { action: 'review_requirement', requirementId: 'req-1', version: 1, expectedSequence: 2, review };
  // The maker's grant switched to checker still cannot review their own proposal: identity is the signed-in actor.
  sqlite.prepare("UPDATE company_compliance_entity_grants SET role='checker' WHERE principal_key=?").run(MAKER);
  assert.equal((await post(body, { email: MAKER })).status, 403);
  sqlite.prepare("UPDATE company_compliance_entity_grants SET role='maker' WHERE principal_key=?").run(MAKER);
  assert.equal((await post({ ...body, review: { ...review, humanSourceReview: false } }, { email: CHECKER })).status, 400);
  assert.equal((await post({ ...body, review: { ...review, evidenceChecksum: 'deadbeef' } }, { email: CHECKER })).status, 409);
  assert.equal((await post({ ...body, review: { ...review, intakeVersion: 2 } }, { email: CHECKER })).status, 409);
  const verified = await post({ ...body, review: { ...review, actor: 'spoofed@pawspace.test' } }, { email: CHECKER });
  assert.equal(verified.status, 200);
  const outcome = await data(verified);
  assert.equal(outcome.history.events.at(-1).actor, CHECKER, 'reviewer identity is the authenticated actor, never the body');
  assert.deepEqual([outcome.readiness.readyForInternalReview, outcome.readiness.filingReady, outcome.readiness.comprehensiveObligations, outcome.filingReady], [true, false, false, false]);
  let view = await data(await get(VIEWER));
  assert.equal(view.readiness.requirements[0].readiness.readyForInternalReview, true);
  assert.equal(tables(sqlite), 9, 'the three readiness tables plus the six foundation tables');
  assert.equal((await post({ action: 'record_intake', intake: { entityId: ENTITY, facts: fullFacts(['pan']) }, expectedVersion: 1 })).status, 201);
  view = await data(await get(VIEWER));
  assert.deepEqual(view.readiness.requirements[0].readiness.blockers, ['intake_version_changed', 'fact_unknown:pan']);
  assert.equal((await post({ action: 'supersede_requirement', requirementId: 'req-1', replacement: { ...requirement, version: 2, supersedes: 1, title: 'SYNTHETIC corrected' } }, { email: VIEWER })).status, 403);
  assert.equal((await post({ action: 'supersede_requirement', requirementId: 'req-1', replacement: { ...requirement, version: 3, supersedes: 2 } })).status, 409);
  assert.equal((await post({ action: 'supersede_requirement', requirementId: 'req-1', replacement: { ...requirement, version: 2, supersedes: 1, title: 'SYNTHETIC corrected' } })).status, 201);
  view = await data(await get(VIEWER));
  assert.deepEqual(view.readiness.requirements.map(r => [r.requirement.version, r.current, r.readiness.readyForInternalReview]), [[1, false, false], [2, true, false]]);
  assert.ok(!JSON.stringify(view).includes('"filingReady":true'));
  // Existing foundation master behaviour is unchanged by the readiness slice.
  assert.equal((await post({ action: 'save_master', company: { entityId: ENTITY, legalName: 'SYNTHETIC Company', cin: '', pan: 'p', registeredOffice: 'o', recordReference: 'r', directors: [], gstRegistrations: [] }, expectedVersion: 0 })).status, 400, 'incomplete company master still refused');
});

test('route level: conflicting known source dates between requirement and retained evidence refuse verification and surface as readiness blockers; matching dates verify', async () => {
  await world();
  assert.equal((await post({ action: 'record_intake', intake: { entityId: ENTITY, facts: fullFacts() }, expectedVersion: 0 })).status, 201);
  const expiredRecord = { ...requirement, id: 'req-expired', source: { authority: 'SYNTHETIC authority', url: 'https://fixture.gov.in/rule', publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' } };
  const record = await data(await post({ action: 'propose_requirement', requirement: expiredRecord }));
  const attached = await data(await post({ action: 'attach_requirement_evidence', requirementId: 'req-expired', version: 1, evidence: { ...evidence, sourceUrl: 'https://fixture.gov.in/rule', publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' } }));
  const review = { outcome: 'verified', reference: 'fixture/review', requirementChecksum: record.checksum, evidenceSequence: attached.evidenceSequence, evidenceChecksum: attached.documentChecksum, intakeVersion: 1, humanSourceReview: true };
  const refused = await post({ action: 'review_requirement', requirementId: 'req-expired', version: 1, expectedSequence: 2, review }, { email: CHECKER });
  assert.equal(refused.status, 409); assert.deepEqual(await refused.json(), { error: 'source_date_conflict:effectiveTo' });
  let view = await data(await get(VIEWER));
  const expired = view.readiness.requirements.find(r => r.requirement.id === 'req-expired');
  assert.equal(expired.readiness.readyForInternalReview, false);
  for (const blocker of ['requirement_not_verified', 'source_date_conflict:effectiveTo', 'effective_expired']) assert.ok(expired.readiness.blockers.includes(blocker), blocker);
  // Future record publication with earlier evidence publication is refused the same way.
  await post({ action: 'propose_requirement', requirement: { ...requirement, id: 'req-future', source: { authority: 'SYNTHETIC authority', url: 'https://fixture.gov.in/rule', publishedOn: '2027-01-01', effectiveFrom: '2027-01-01' } } });
  const futureRecord = (await data(await get())).readiness.requirements.find(r => r.requirement.id === 'req-future').requirement;
  const futureEvidence = await data(await post({ action: 'attach_requirement_evidence', requirementId: 'req-future', version: 1, evidence: { ...evidence, sourceUrl: 'https://fixture.gov.in/rule', publishedOn: '2026-01-01', effectiveFrom: '2026-01-01' } }));
  const refusedFuture = await post({ action: 'review_requirement', requirementId: 'req-future', version: 1, expectedSequence: 2, review: { ...review, requirementChecksum: futureRecord.checksum, evidenceSequence: futureEvidence.evidenceSequence, evidenceChecksum: futureEvidence.documentChecksum } }, { email: CHECKER });
  assert.equal(refusedFuture.status, 409); assert.deepEqual(await refusedFuture.json(), { error: 'source_date_conflict:publishedOn' });
  // Matching known dates: independently authenticated checker verifies; readiness true, internal only.
  await post({ action: 'propose_requirement', requirement: { ...requirement, id: 'req-match', source: { authority: 'SYNTHETIC authority', url: 'https://fixture.gov.in/rule', publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' } } });
  const matchRecord = (await data(await get())).readiness.requirements.find(r => r.requirement.id === 'req-match').requirement;
  const matchEvidence = await data(await post({ action: 'attach_requirement_evidence', requirementId: 'req-match', version: 1, evidence: { ...evidence, sourceUrl: 'https://fixture.gov.in/rule', publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' } }));
  const verified = await post({ action: 'review_requirement', requirementId: 'req-match', version: 1, expectedSequence: 2, review: { ...review, requirementChecksum: matchRecord.checksum, evidenceSequence: matchEvidence.evidenceSequence, evidenceChecksum: matchEvidence.documentChecksum } }, { email: CHECKER });
  assert.equal(verified.status, 200);
  const outcome = await data(verified);
  assert.equal(outcome.history.events.at(-1).actor, CHECKER);
  assert.deepEqual([outcome.readiness.readyForInternalReview, outcome.readiness.blockers, outcome.readiness.filingReady, outcome.readiness.comprehensiveObligations], [true, [], false, false]);
  view = await data(await get(VIEWER));
  assert.deepEqual(view.readiness.requirements.map(r => [r.requirement.id, r.readiness.readyForInternalReview]), [['req-expired', false], ['req-future', false], ['req-match', true]]);
});
