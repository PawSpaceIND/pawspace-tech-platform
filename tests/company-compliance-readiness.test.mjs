import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { freshSqlite, makeD1 } from './helpers/taxi-harness.mjs';
installWorkersHooks('__COMPANY_COMPLIANCE_READINESS_DOMAIN_DB__');
const intakeLib = await import('../lib/company-compliance/intake.ts');
const req = await import('../lib/company-compliance/requirements.ts');
const { FACT_KEYS } = await import('../lib/company-compliance/readiness-contract.ts');
const { checksum, validateCompany } = await import('../lib/company-compliance/workflow.ts');
const { readFinanceMaster } = await import('../lib/company-compliance/store.ts');

// Synthetic fixtures only. No fact here is a real company fact and no requirement text is a legal determination.
const ENTITY = 'fixture-IN', MAKER = 'fixture-maker@pawspace.test', CHECKER = 'fixture-checker@pawspace.test', OTHER = 'fixture-other@pawspace.test';
const fullFacts = (unknown = []) => Object.fromEntries(FACT_KEYS.map(key => [key, unknown.includes(key) ? { state: 'unknown' } : { state: 'provided', value: `SYNTHETIC ${key}`, sourceReference: `fixture/${key}` }]));
const requirementInput = (overrides = {}) => ({ entityId: ENTITY, id: 'req-1', version: 1, area: 'other', title: 'SYNTHETIC requirement', obligationSummary: 'SYNTHETIC obligation text; not a legal determination.', source: { authority: 'SYNTHETIC authority', url: 'https://fixture.gov.in/synthetic', publishedOn: '2026-01-01', effectiveFrom: '2026-01-01' }, applicabilityFactKeys: ['cin', 'pan'], ...overrides });
const officialEvidence = (overrides = {}) => ({ kind: 'official_document', reference: 'fixture/evidence', sourceUrl: 'https://fixture.gov.in/synthetic-notification', quotedText: 'SYNTHETIC quoted text retained from the fixture source.', ...overrides });
function world() {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  sqlite.exec('CREATE TABLE finance_entities(id TEXT PRIMARY KEY,legal_name TEXT,country_code TEXT,status TEXT)');
  sqlite.prepare('INSERT INTO finance_entities VALUES (?,?,?,?)').run(ENTITY, 'SYNTHETIC Company', 'IN', 'active');
  return { sqlite, db };
}
async function verifiedWorld() {
  const w = world();
  await intakeLib.recordIntake(w.db, ENTITY, { entityId: ENTITY, facts: fullFacts() }, 0, MAKER);
  const record = await req.proposeRequirement(w.db, ENTITY, requirementInput(), MAKER);
  const attached = await req.attachRequirementEvidence(w.db, ENTITY, 'req-1', 1, officialEvidence(), MAKER);
  const review = { outcome: 'verified', reference: 'fixture/review', requirementChecksum: record.checksum, evidenceSequence: attached.evidenceSequence, evidenceChecksum: attached.documentChecksum, intakeVersion: 1, humanSourceReview: true };
  const result = await req.reviewRequirement(w.db, ENTITY, 'req-1', 1, 2, review, CHECKER);
  return { ...w, record, attached, review, result };
}
const rejects = (promise, pattern, status) => assert.rejects(promise, error => (pattern.test(error.message) && (status === undefined || error.status === status)) || (() => { throw new Error(`expected ${pattern} (${status ?? 'any'}) got ${error.message} (${error.status})`); })());

test('intake keeps UNKNOWN explicit, refuses incomplete or value-bearing unknown facts, and never relaxes the company master', async () => {
  const { db } = world();
  const facts = fullFacts(['cin', 'gstins']);
  const { cin: _dropped, ...missingCin } = facts;
  await rejects(intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts: missingCin }, 0, MAKER), /intake_fact_keys_incomplete/);
  await rejects(intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts: { ...facts, cin: undefined } }, 0, MAKER), /intake_fact_invalid:cin/);
  await rejects(intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts: { ...facts, cin: { state: 'unknown', value: 'leak' } } }, 0, MAKER), /intake_unknown_carries_values:cin/);
  await rejects(intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts: { ...facts, pan: { state: 'provided', value: 'x', sourceReference: '' } } }, 0, MAKER), /intake_fact_incomplete:pan/);
  await rejects(intakeLib.recordIntake(db, ENTITY, { entityId: 'other', facts }, 0, MAKER), /intake_entity_mismatch/);
  await rejects(intakeLib.recordIntake(db, 'other-entity', { entityId: 'other-entity', facts }, 0, MAKER), /active_indian_finance_entity_required/, 404);
  const saved = await intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts }, 0, MAKER);
  assert.deepEqual(saved, { version: 1, unknownFacts: ['cin', 'gstins'], mode: 'draft_only' });
  await rejects(intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts }, 0, MAKER), /intake_version_conflict/, 409);
  const read = await intakeLib.readIntake(db, ENTITY);
  assert.equal(read.version, 1); assert.deepEqual(read.record.facts.cin, { state: 'unknown' }); assert.equal(read.record.facts.pan.state, 'provided');
  assert.deepEqual(intakeLib.factStates(read, ['cin', 'pan']), { cin: 'unknown', pan: 'provided' });
  // The master's own validation is untouched: an incomplete company is still refused there.
  assert.throws(() => validateCompany({ entityId: ENTITY, legalName: 'x', cin: '', pan: 'p', registeredOffice: 'o', recordReference: 'r', directors: [], gstRegistrations: [] }), /cin_required/);
  assert.deepEqual((await readFinanceMaster(db, ENTITY)).missingCompanyFields, ['cin', 'pan', 'registeredOffice', 'directors']);
});

test('a proposed requirement is never ready, and lineage, area and fact keys are validated without seeding any legal value', async () => {
  const { db } = world();
  await rejects(req.proposeRequirement(db, ENTITY, requirementInput({ version: 2 }), MAKER), /requirement_lineage_required/);
  await rejects(req.proposeRequirement(db, ENTITY, requirementInput({ applicabilityFactKeys: ['not_a_fact'] }), MAKER), /invalid_applicability_fact_key/);
  await rejects(req.proposeRequirement(db, ENTITY, requirementInput({ applicabilityFactKeys: [] }), MAKER), /applicability_fact_keys_required/);
  await rejects(req.proposeRequirement(db, ENTITY, requirementInput({ area: 'tax' }), MAKER), /invalid_requirement_area/);
  await rejects(req.proposeRequirement(db, ENTITY, requirementInput({ source: { authority: 'x', url: 'http://fixture.gov.in/' } }), MAKER), /invalid_source_url/);
  await rejects(req.proposeRequirement(db, ENTITY, requirementInput({ source: { authority: 'x', effectiveFrom: '2026-02-01', effectiveTo: '2026-01-01' } }), MAKER), /invalid_effective_range/);
  const record = await req.proposeRequirement(db, ENTITY, requirementInput(), MAKER);
  assert.equal(record.mode, 'draft_only'); assert.equal(record.checksum, await req.requirementChecksum(record));
  await rejects(req.proposeRequirement(db, ENTITY, requirementInput(), MAKER), /requirement_exists/, 409);
  const view = await req.readReadiness(db, ENTITY);
  assert.equal(view.intake, null);
  const [only] = view.requirements;
  assert.equal(only.readiness.readyForInternalReview, false); assert.equal(only.readiness.filingReady, false); assert.equal(only.readiness.comprehensiveObligations, false);
  for (const blocker of ['requirement_not_verified', 'intake_missing']) assert.ok(only.readiness.blockers.includes(blocker), blocker);
  assert.ok(!JSON.stringify(view).includes('"filingReady":true'));
});

test('evidence must be retained quoted text; the checksum is computed by the server and official evidence needs an official host', async () => {
  const { db } = world();
  await req.proposeRequirement(db, ENTITY, requirementInput(), MAKER);
  await rejects(req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ quotedText: '' }), MAKER), /retained_quoted_text_required/);
  await rejects(req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ quotedText: 'x'.repeat(4001) }), MAKER), /retained_quoted_text_required/);
  await rejects(req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ sourceUrl: 'https://fixture.example.com/' }), MAKER), /official_source_required/);
  await rejects(req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ sourceUrl: 'https://gov.in/' }), MAKER), /official_source_required/);
  await rejects(req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ sourceUrl: undefined }), MAKER), /official_source_required/);
  await rejects(req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ kind: 'secondary', sourceUrl: 'http://fixture.gov.in/' }), MAKER), /invalid_source_url/);
  const attached = await req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ documentChecksum: 'typed-by-caller' }), MAKER);
  assert.equal(attached.documentChecksum, await checksum(officialEvidence().quotedText), 'checksum derives from retained text, not the caller');
  assert.equal(attached.history.events.at(-1).evidence.capturedBy, MAKER);
  await rejects(req.attachRequirementEvidence(db, ENTITY, 'req-1', 2, officialEvidence(), MAKER), /requirement_not_found/, 404);
});

test('independent review binds the authenticated checker, refuses self-review, and pins version, checksums, intake version and fact states', async () => {
  const { db } = world();
  await intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts: fullFacts(['pan']) }, 0, MAKER);
  const record = await req.proposeRequirement(db, ENTITY, requirementInput(), MAKER);
  const attached = await req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence(), MAKER);
  const review = { outcome: 'verified', reference: 'fixture/review', requirementChecksum: record.checksum, evidenceSequence: 2, evidenceChecksum: attached.documentChecksum, intakeVersion: 1, humanSourceReview: true };
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 2, review, MAKER), /maker_checker_required/, 403);
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 1, review, CHECKER), /requirement_review_conflict/, 409);
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 2, { ...review, humanSourceReview: false }, CHECKER), /human_source_review_required/);
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 2, { ...review, requirementChecksum: 'deadbeef' }, CHECKER), /requirement_checksum_mismatch/, 409);
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 2, { ...review, evidenceChecksum: 'deadbeef' }, CHECKER), /evidence_checksum_mismatch/, 409);
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 2, { ...review, evidenceSequence: 1 }, CHECKER), /evidence_sequence_required/);
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 2, { ...review, intakeVersion: 2 }, CHECKER), /intake_version_mismatch/, 409);
  // UNKNOWN applicability fact (pan) blocks verification outright.
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 2, review, CHECKER), /applicability_facts_unknown/);
  // Rejection is still possible and pins what the reviewer saw.
  const rejected = await req.reviewRequirement(db, ENTITY, 'req-1', 1, 2, { ...review, outcome: 'rejected' }, CHECKER);
  assert.deepEqual(rejected.history.events.at(-1).pin.factStates, { cin: 'provided', pan: 'unknown' });
  assert.equal(rejected.readiness.readyForInternalReview, false);
  // Evidence captured by the checker cannot be reviewed by that checker.
  const byChecker = await req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ reference: 'fixture/evidence-2' }), CHECKER);
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 4, { ...review, outcome: 'rejected', evidenceSequence: byChecker.evidenceSequence, evidenceChecksum: byChecker.documentChecksum }, CHECKER), /maker_checker_required/, 403);
  // Secondary evidence can never be verified.
  const secondary = await req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ kind: 'secondary', reference: 'fixture/secondary', sourceUrl: 'https://fixture.example.com/' }), MAKER);
  await intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts: fullFacts() }, 1, MAKER);
  await rejects(req.reviewRequirement(db, ENTITY, 'req-1', 1, 5, { ...review, evidenceSequence: secondary.evidenceSequence, evidenceChecksum: secondary.documentChecksum, intakeVersion: 2 }, OTHER), /official_evidence_required/);
});

test('verified readiness is internal only and is invalidated by a new intake version, supersession, conflict or stored-material drift', async () => {
  const { db, sqlite, record, result } = await verifiedWorld();
  assert.deepEqual(result.readiness, { ...result.readiness, readyForInternalReview: true, filingReady: false, comprehensiveObligations: false, blockers: [] });
  assert.equal(result.filingReady, false);
  const pin = result.history.events.at(-1).pin;
  assert.deepEqual([pin.requirementChecksum, pin.intakeVersion, pin.evidenceSequence, pin.factStates], [record.checksum, 1, 2, { cin: 'provided', pan: 'provided' }]);
  let view = await req.readReadiness(db, ENTITY);
  assert.equal(view.requirements[0].readiness.readyForInternalReview, true);
  // A fact change (new intake version) invalidates readiness even if every fact is still provided.
  await intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts: fullFacts() }, 1, MAKER);
  view = await req.readReadiness(db, ENTITY);
  assert.deepEqual(view.requirements[0].readiness.blockers, ['intake_version_changed']);
  // A later unknown fact blocks with its name.
  await intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts: fullFacts(['cin']) }, 2, MAKER);
  view = await req.readReadiness(db, ENTITY);
  assert.ok(view.requirements[0].readiness.blockers.includes('fact_unknown:cin'));
  // Conflict after verification blocks.
  await req.reviewRequirement(db, ENTITY, 'req-1', 1, 3, { outcome: 'conflict', reference: 'fixture/conflict', requirementChecksum: record.checksum, evidenceSequence: 2, evidenceChecksum: pin.evidenceChecksum, intakeVersion: 3, humanSourceReview: true }, CHECKER);
  view = await req.readReadiness(db, ENTITY);
  assert.ok(view.requirements[0].readiness.blockers.includes('requirement_conflict'));
  // Supersession: the old version is stale and the new one starts unverified.
  await rejects(req.supersedeRequirement(db, ENTITY, 'req-1', requirementInput({ version: 3, supersedes: 2 }), MAKER), /requirement_lineage_conflict/, 409);
  const next = await req.supersedeRequirement(db, ENTITY, 'req-1', requirementInput({ version: 2, supersedes: 1, title: 'SYNTHETIC corrected' }), MAKER);
  view = await req.readReadiness(db, ENTITY);
  const [old, fresh] = view.requirements;
  assert.equal(old.current, false); assert.ok(old.readiness.blockers.includes('requirement_superseded')); assert.equal(old.history.events.at(-1).status, 'superseded');
  assert.equal(fresh.requirement.version, 2); assert.equal(fresh.requirement.checksum, next.checksum); assert.ok(fresh.readiness.blockers.includes('requirement_not_verified'));
  await rejects(req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence(), MAKER), /invalid_requirement_transition/, 409);
  // Stored quoted text tampered after verification: checksum drift is detected on read.
  const w2 = await verifiedWorld();
  const row = w2.sqlite.prepare("SELECT event_json FROM company_compliance_requirement_reviews WHERE requirement_id='req-1' AND sequence=2").get();
  const event = JSON.parse(row.event_json); event.evidence.quotedText = 'ALTERED after review';
  w2.sqlite.prepare("UPDATE company_compliance_requirement_reviews SET event_json=? WHERE requirement_id='req-1' AND sequence=2").run(JSON.stringify(event));
  const drifted = await req.readReadiness(w2.db, ENTITY);
  assert.deepEqual(drifted.requirements[0].readiness.blockers, ['evidence_checksum_drift']);
  // Stored requirement text tampered: integrity failure refuses the read instead of evaluating.
  const stored = JSON.parse(w2.sqlite.prepare("SELECT record_json FROM company_compliance_requirements WHERE id='req-1'").get().record_json);
  stored.obligationSummary = 'ALTERED'; w2.sqlite.prepare("UPDATE company_compliance_requirements SET record_json=? WHERE id='req-1'").run(JSON.stringify(stored));
  await rejects(req.readReadiness(w2.db, ENTITY), /requirement_storage_integrity_mismatch/, 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'company_compliance_%'").get().n, 3, 'only the three owned readiness tables were created');
});

test('pure evaluator fails closed on unknown or future publication, unstarted or expired effect, evidence captured before publication and missing independence', async () => {
  const { record, result } = await verifiedWorld();
  const intake = { version: 1, record: { entityId: ENTITY, facts: fullFacts() }, createdBy: MAKER, createdAt: '2026-10-03T00:00:00.000Z' };
  const history = result.history;
  const at = (iso) => new Date(iso);
  const blockersWith = async (patchRecord = {}, patchEvidence = {}, now = '2026-10-03T12:00:00Z', patchHistory = (h) => h) => {
    const r = { ...record, source: { ...record.source, ...patchRecord } }; r.checksum = await req.requirementChecksum(r);
    const h = structuredClone(history); h.events[1].evidence = { ...h.events[1].evidence, ...patchEvidence }; h.events[2].pin.requirementChecksum = r.checksum;
    return (await req.requirementReadiness(r, patchHistory(h), intake, at(now), true)).blockers;
  };
  assert.deepEqual(await blockersWith(), []);
  assert.deepEqual(await blockersWith({ publishedOn: undefined, effectiveFrom: undefined }), ['publication_date_unknown', 'effective_from_unknown']);
  assert.deepEqual(await blockersWith({ publishedOn: '2027-01-01', effectiveFrom: '2027-01-01' }), ['publication_in_future', 'effective_not_started', 'evidence_captured_before_publication']);
  assert.deepEqual(await blockersWith({ effectiveTo: '2026-06-30' }), ['effective_expired']);
  assert.deepEqual(await blockersWith({}, { capturedAt: '2025-12-31T00:00:00.000Z' }), ['evidence_captured_before_publication']);
  assert.deepEqual(await blockersWith({}, { kind: 'secondary' }), ['evidence_not_official']);
  assert.deepEqual(await blockersWith({}, {}, '2026-10-03T12:00:00Z', h => { h.events[2].actor = h.events[0].actor; return h; }), ['independent_review_missing']);
  assert.deepEqual(await blockersWith({}, {}, '2026-10-03T12:00:00Z', h => { h.events[2].pin.intakeVersion = 9; return h; }), ['intake_version_changed']);
  const evaluated = await req.requirementReadiness(record, history, intake, at('2026-10-03T12:00:00Z'), true);
  assert.equal(evaluated.filingReady, false); assert.equal(evaluated.comprehensiveObligations, false);
  assert.ok(!('legalReady' in evaluated));
});

test('known source dates that disagree between the requirement and the retained evidence are a conflict: verification is refused and readiness names it, never silently preferring either range', async () => {
  const flow = async (recordSource, evidenceDates, actor = CHECKER) => {
    const { db } = world();
    await intakeLib.recordIntake(db, ENTITY, { entityId: ENTITY, facts: fullFacts() }, 0, MAKER);
    const record = await req.proposeRequirement(db, ENTITY, requirementInput({ source: { authority: 'SYNTHETIC authority', url: 'https://fixture.gov.in/rule', ...recordSource } }), MAKER);
    const attached = await req.attachRequirementEvidence(db, ENTITY, 'req-1', 1, officialEvidence({ sourceUrl: 'https://fixture.gov.in/rule', ...evidenceDates }), MAKER);
    const review = { outcome: 'verified', reference: 'fixture/review', requirementChecksum: record.checksum, evidenceSequence: attached.evidenceSequence, evidenceChecksum: attached.documentChecksum, intakeVersion: 1, humanSourceReview: true };
    return { db, record, attached, review, verify: () => req.reviewRequirement(db, ENTITY, 'req-1', 1, 2, review, actor), readiness: async () => (await req.readReadiness(db, ENTITY)).requirements[0].readiness };
  };
  const now = new Date('2026-10-03T12:00:00Z');
  // Expired requirement range, later evidence range (the reported case).
  const expired = await flow({ publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }, { publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' });
  await rejects(expired.verify(), /source_date_conflict:effectiveTo/, 409);
  let readiness = await expired.readiness();
  assert.equal(readiness.readyForInternalReview, false);
  assert.ok(readiness.blockers.includes('source_date_conflict:effectiveTo') && readiness.blockers.includes('effective_expired'), JSON.stringify(readiness.blockers));
  // A rejection or conflict review is still recordable so the disagreement is on the audit trail.
  const flagged = await req.reviewRequirement(expired.db, ENTITY, 'req-1', 1, 2, { ...expired.review, outcome: 'conflict' }, CHECKER);
  assert.equal(flagged.history.events.at(-1).status, 'conflict'); assert.equal(flagged.readiness.readyForInternalReview, false);
  // Future requirement publication, earlier evidence publication.
  const future = await flow({ publishedOn: '2027-01-01', effectiveFrom: '2027-01-01' }, { publishedOn: '2026-01-01', effectiveFrom: '2026-01-01' });
  await rejects(future.verify(), /source_date_conflict:publishedOn/, 409);
  readiness = await future.readiness();
  for (const blocker of ['source_date_conflict:publishedOn', 'source_date_conflict:effectiveFrom', 'publication_in_future', 'effective_not_started']) assert.ok(readiness.blockers.includes(blocker), blocker);
  // Matching known dates verify and are ready; the record's own dates are what readiness used.
  const matching = await flow({ publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' }, { publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' });
  const verified = await matching.verify();
  assert.deepEqual([verified.readiness.readyForInternalReview, verified.readiness.blockers, verified.readiness.filingReady, verified.readiness.comprehensiveObligations], [true, [], false, false]);
  assert.equal((await matching.readiness()).readyForInternalReview, true);
  // Evidence may only fill a date the record leaves unknown; it cannot override a stated one even when the stated one is the problem.
  const supplemented = await flow({}, { publishedOn: '2026-01-01', effectiveFrom: '2026-01-01' });
  assert.equal((await supplemented.verify()).readiness.readyForInternalReview, true);
  const stated = await flow({ effectiveTo: '2026-06-30' }, { publishedOn: '2026-01-01', effectiveFrom: '2026-01-01' });
  assert.equal((await stated.verify()).readiness.readyForInternalReview, false, 'expired record date is not rescued by evidence');
  assert.deepEqual((await stated.readiness()).blockers, ['effective_expired']);
  // Pure resolver and evaluator: conflicts are reported, not resolved; mismatched history scope is a blocker.
  assert.deepEqual(req.resolveSourceDates({ source: { authority: 'x', effectiveTo: '2026-06-30' } }, { publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' }), { dates: { publishedOn: '2026-01-01', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }, conflicts: ['source_date_conflict:effectiveTo'] });
  const { record, result } = await verifiedWorld();
  const intake = { version: 1, record: { entityId: ENTITY, facts: fullFacts() }, createdBy: MAKER, createdAt: '2026-10-03T00:00:00.000Z' };
  assert.deepEqual((await req.requirementReadiness(record, result.history, intake, now, true)).blockers, []);
  for (const patch of [{ entityId: 'other-entity' }, { requirementId: 'req-9' }, { version: 2 }]) assert.deepEqual((await req.requirementReadiness(record, { ...result.history, ...patch }, intake, now, true)).blockers, ['history_scope_mismatch'], JSON.stringify(patch));
});
