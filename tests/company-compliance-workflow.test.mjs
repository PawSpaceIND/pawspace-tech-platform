import test from 'node:test';
import assert from 'node:assert/strict';
import { calendar, prepareReturn, createDraft, printableHtml, validateSignedCopy, routeSignedCopy, appendAudit } from '../lib/company-compliance/workflow.ts';

// Synthetic fixtures, never company master data or actual approvals.
const company = { entityId: 'fixture-IN', legalName: 'Fixture <Company>', cin: 'fixture-CIN', pan: 'fixture-PAN', registeredOffice: 'Fixture address', recordReference: 'fixture/master/1', directors: [{ id: 'director-1', name: 'Fixture Director', din: 'fixture-DIN', recordReference: 'fixture/director/1' }], gstRegistrations: [{ id: 'reg-1', gstin: 'fixture-GSTIN', frequency: 'monthly' }] };
const evidence = { reference: 'fixture/review', sourceUrl: 'https://www.mca.gov.in/', reviewedBy: 'fixture-reviewer', reviewedOn: '2026-10-03' };
const meeting = { id: 'meeting-1', entityId: company.entityId, date: '2026-09-30', location: 'Fixture room', recordReference: 'fixture/meeting/1', state: 'held', attendance: ['director-1'], chairId: 'director-1', quorumConfirmed: true, agenda: [{ title: 'Review actual supplied accounts', recordReference: 'fixture/accounts/1' }], decisions: [{ id: 'decision-1', text: 'Explicit fixture decision; no implied approval.', recordReference: 'fixture/decision/1', outcome: 'passed' }] };
const draftInput = { id: 'draft-1', version: 1, kind: 'minutes', signers: ['director-1'], pageCount: 1 };
const makeDraft = () => createDraft(company, meeting, draftInput);
const copyOf = draft => ({ id: 'copy-1', entityId: draft.entityId, draftId: draft.id, draftVersion: draft.version, draftChecksum: draft.checksum, localDocumentReference: 'local/private/copy-1', fileChecksum: 'a'.repeat(64), pageCount: 1, signers: ['director-1'], completenessReviewedBy: 'fixture-reviewer', matchesOriginal: true });

test('calendar requires reviewed applicability and actual event; handles year rollover and notified override', () => {
  const rule = { id: 'AOC-fixture', entityId: company.entityId, title: 'Reviewed event filing', period: 'FY-fixture', cadence: 'annual', applicability: 'applicable', basis: 'Fixture review only', evidence, due: { kind: 'event', daysAfter: 30 } };
  assert.equal(calendar(company, [rule])[0].dueDate, null);
  const actual = { ...rule, due: { ...rule.due, eventDate: '2026-12-20', eventReference: 'actual-event-fixture' } };
  assert.equal(calendar(company, [actual])[0].dueDate, '2027-01-19');
  assert.equal(calendar(company, [{ ...actual, override: { date: '2027-02-01', evidence } }])[0].dueDate, '2027-02-01');
  assert.equal(calendar(company, [{ ...actual, evidence: undefined }])[0].state, 'review_required');
  assert.equal(calendar(company, [{ ...actual, applicability: 'unknown' }])[0].dueDate, null);
  assert.equal(calendar(company, [{ ...actual, applicability: 'not_applicable' }])[0].state, 'excluded');
  assert.throws(() => calendar(company, [{ ...actual, entityId: 'other-company' }]), /entity_mismatch/);
  assert.throws(() => calendar(company, [{ ...actual, registrationId: 'other-reg' }]), /registration_mismatch/);
  assert.throws(() => calendar(company, [{ ...actual, due: { ...actual.due, eventDate: '2026-02-30' } }]), /invalid_date/);
  assert.throws(() => calendar(company, [actual, actual]), /duplicate_rule/);
});

test('saved Finance snapshot preserves scope and blocks missing review/reconciliation', async () => {
  const scope = { entityId: company.entityId, registrationId: 'reg-1', artifactId: 'return-1', period: '2026-09' };
  const snapshot = { ...scope, version: 1, checksum: 'finance-checksum', status: 'reviewed', reconciliation: 'clean', blockers: [], sourceReferences: ['fixture/register/1'] };
  const result = await prepareReturn({ readSavedReturn: async () => snapshot }, scope);
  assert.equal(result.readyForReview, true); assert.equal(result.mode, 'draft_only');
  snapshot.sourceReferences.push('mutated'); assert.equal(result.snapshot.sourceReferences.length, 1);
  const blocked = await prepareReturn({ readSavedReturn: async () => ({ ...snapshot, reconciliation: 'mismatch', status: 'draft' }) }, scope);
  assert.deepEqual(blocked.blockers, ['finance_review_pending', 'reconciliation_not_clean']);
  assert.equal((await prepareReturn({ readSavedReturn: async () => null }, scope)).readyForReview, false);
  await assert.rejects(prepareReturn({ readSavedReturn: async () => ({ ...snapshot, entityId: 'other' }) }, scope), /scope_mismatch/);
  await assert.rejects(prepareReturn({ readSavedReturn: async () => ({ ...snapshot, registrationId: 'other' }) }, scope), /scope_mismatch/);
});

test('minutes cannot invent held meetings, quorum, directors or decisions; print escapes records', async () => {
  const draft = await makeDraft();
  assert.match(draft.text, /PASSED/); assert.match(draft.text, /Fixture Director/); assert.equal(draft.checksum.length, 64);
  assert.match(printableHtml(draft), /Fixture &lt;Company&gt;/); assert.match(printableHtml(draft), /size:A4/);
  for (const patch of [{ state: 'planned' }, { quorumConfirmed: false }, { quorumConfirmed: 'false' }, { decisions: [] }, { chairId: 'unknown' }, { attendance: ['unknown'] }, { decisions: [{ ...meeting.decisions[0], outcome: 'proposed' }] }]) {
    await assert.rejects(createDraft(company, { ...meeting, ...patch }, draftInput));
  }
  await assert.rejects(createDraft(company, meeting, { ...draftInput, signers: ['unknown'] }), /signer/);
  await assert.rejects(createDraft(company, meeting, { ...draftInput, version: 2 }), /lineage/);
  const proposal = await createDraft(company, { ...meeting, state: 'planned', decisions: [{ ...meeting.decisions[0], outcome: 'proposed' }] }, { ...draftInput, kind: 'resolution' });
  assert.match(proposal.text, /PROPOSED/); assert.doesNotMatch(proposal.text, /PASSED/);
});

test('signed copy validates entity, original version, checksum, pages and exact signer completeness', async () => {
  const draft = await makeDraft(), copy = copyOf(draft);
  assert.equal(validateSignedCopy(draft, copy).id, 'copy-1');
  for (const patch of [{ entityId: 'other' }, { draftVersion: 2 }, { draftChecksum: 'stale' }, { pageCount: 2 }, { signers: [] }, { signers: ['director-1', 'unknown'] }, { matchesOriginal: false }, { matchesOriginal: 'false' }, { fileChecksum: 'invalid' }]) assert.throws(() => validateSignedCopy(draft, { ...copy, ...patch }));
});

test('filing is assessed per document; wet signature does not bypass electronic signing/certification', async () => {
  const draft = await makeDraft(), copy = copyOf(draft);
  const assessment = { entityId: draft.entityId, draftId: draft.id, draftVersion: draft.version, required: 'unknown', reason: 'Await applicability review' };
  assert.equal(routeSignedCopy(draft, copy, assessment).destination, 'review_required');
  assert.equal(routeSignedCopy(draft, copy, { ...assessment, required: 'no', evidence }).destination, 'internal_retention');
  const filing = { ...assessment, required: 'yes', evidence, authority: 'MCA', form: 'reviewed-form' };
  assert.equal(routeSignedCopy(draft, copy, filing).destination, 'review_required');
  const routed = routeSignedCopy(draft, copy, { ...filing, signingRequirements: 'Reviewer must verify form-specific DSC', certificationRequirements: 'Reviewer must verify professional certification' });
  assert.equal(routed.destination, 'manual_portal_review'); assert.equal(routed.liveFilingEnabled, false);
  assert.equal(routed.portal, 'https://www.mca.gov.in/');
  assert.throws(() => routeSignedCopy(draft, copy, { ...assessment, draftVersion: 2 }), /scope_mismatch/);
});

test('append-only history records rejection and resubmission without fabricating acceptance', () => {
  let history = { entityId: company.entityId, draftId: 'draft-1', version: 1, events: [] };
  const events = ['draft', 'draft_reviewed', 'signed_copy_pending_review', 'signed_copy_reviewed', 'manual_filing_pending', 'rejected', 'manual_filing_pending', 'acknowledged'];
  for (const [i, status] of events.entries()) {
    const before = structuredClone(history);
    const next = appendAudit(history, { actor: 'fixture-human', at: `2026-10-03T10:0${i}:00Z`, status, reference: `fixture-evidence-${i}`, note: 'Human supplied status; not portal verified' });
    assert.deepEqual(history, before); history = next;
  }
  assert.equal(history.events[5].status, 'rejected'); assert.equal(history.events.length, 8);
  assert.throws(() => appendAudit({ ...history, events: [] }, { actor: 'human', at: '2026-10-03T10:10:00Z', status: 'acknowledged', reference: 'ack', note: 'invalid jump' }), /transition/);
  assert.throws(() => appendAudit(history, { actor: 'human', at: '2026-10-03T09:00:00Z', status: 'rejected', reference: 'reject', note: 'out of order' }), /time_out_of_order/);
});
