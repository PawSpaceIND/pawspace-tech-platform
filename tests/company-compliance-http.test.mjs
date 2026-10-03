import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { freshSqlite, makeD1 } from './helpers/taxi-harness.mjs';
import { fixturePdf } from './helpers/company-compliance-fixtures.mjs';
installWorkersHooks('__COMPANY_COMPLIANCE_DB__', '__COMPANY_COMPLIANCE_ENV__');
const store = await import('../lib/company-compliance/store.ts');
const route = await import('../app/api/company-compliance-drafts/route.ts');
const { ensureSecurityTables } = await import('../lib/server-auth.ts');
const { checksum } = await import('../lib/company-compliance/workflow.ts');
const ORIGIN = 'https://compliance.pawspace.test';
const EMAIL = 'fixture-finance@pawspace.test';
const CHECKER = 'fixture-checker@pawspace.test';
const company = { entityId: 'fixture-IN', legalName: 'SYNTHETIC Company', cin: 'fixture-CIN', pan: 'fixture-PAN', registeredOffice: 'Synthetic test address', recordReference: 'fixture/master', directors: [{ id: 'dir-1', name: 'SYNTHETIC Director', din: 'fixture-DIN', recordReference: 'fixture/director' }], gstRegistrations: [{ id: 'reg-1', gstin: 'fixture-GSTIN', frequency: 'unknown' }] };
const meeting = { id: 'meeting-1', entityId: company.entityId, date: '2026-10-03', location: 'SYNTHETIC room', recordReference: 'fixture/meeting', state: 'planned', attendance: [], agenda: [{ title: 'SYNTHETIC agenda for rendering verification', recordReference: 'fixture/agenda' }], decisions: [] };
const draftInput = { id: 'draft-1', version: 1, kind: 'agenda', signers: ['dir-1'], pageCount: 1 };
async function world() {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__COMPANY_COMPLIANCE_DB__ = db;
  globalThis.__COMPANY_COMPLIANCE_ENV__ = { COMPANY_COMPLIANCE_DRAFTS_ENABLED: 'true' };
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const [id, email, role] of [['finance', EMAIL, 'finance'], ['manager', 'fixture-manager@pawspace.test', 'manager'], ['checker', CHECKER, 'finance']]) sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(id, email, id, role, now, now);
  sqlite.exec('CREATE TABLE finance_entities(id TEXT PRIMARY KEY,legal_name TEXT,country_code TEXT,status TEXT,secret_credentials TEXT); CREATE TABLE tax_registrations(id TEXT PRIMARY KEY,entity_id TEXT,registration_type TEXT,registration_reference TEXT,jurisdiction TEXT,status TEXT)');
  sqlite.prepare('INSERT INTO finance_entities VALUES (?,?,?,?,?)').run(company.entityId, company.legalName, 'IN', 'active', 'DO-NOT-EXPOSE-SYNTHETIC-SECRET');
  sqlite.prepare('INSERT INTO tax_registrations VALUES (?,?,?,?,?,?)').run('reg-1', company.entityId, 'gst', 'fixture-GSTIN', 'KA', 'active');
  await store.ensureDraftTables(db);
  for (const [principal, role] of [[EMAIL, 'maker'], [CHECKER, 'checker']]) sqlite.prepare('INSERT INTO company_compliance_entity_grants VALUES (?,?,?,?,?,?,?)').run(company.entityId, principal, role, 'active', new Date(Date.now()+86400000).toISOString(), 'fixture-access-owner', 'fixture/grant');
  return { sqlite, db };
}
async function get(entityId = company.entityId, email = EMAIL, suffix = '') {
  return route.GET(new Request(`${ORIGIN}/api/company-compliance-drafts?entityId=${entityId}${suffix}`, { headers: email ? { 'oai-authenticated-user-email': email } : {} }));
}
async function post(input, { entityId = company.entityId, email = EMAIL, origin = ORIGIN, suffix = '' } = {}) {
  return route.POST(new Request(`${ORIGIN}/api/company-compliance-drafts?entityId=${entityId}${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(email ? { 'oai-authenticated-user-email': email } : {}) }, body: JSON.stringify(input) }));
}
async function draftWorld() {
  const w = await world();
  assert.equal((await post({ action: 'save_master', company, expectedVersion: 0 })).status, 201);
  const response = await post({ action: 'create_draft', meeting, draft: draftInput });
  assert.equal(response.status, 201); return { ...w, draft: (await response.json()).data };
}

test('actual route rejects anonymous/non-Finance actors; reads selected master without secrets or schema mutation', async () => {
  const { sqlite } = await world();
  assert.ok((await get(company.entityId, null)).status >= 400);
  assert.equal((await get(company.entityId, 'fixture-manager@pawspace.test')).status, 403);
  const response = await get(); assert.equal(response.status, 200);
  const text = await response.text(); assert.match(text, /SYNTHETIC Company/); assert.doesNotMatch(text, /DO-NOT-EXPOSE|secret_credentials/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'company_compliance_%'").get().n, 6);
  assert.equal((await get('other-entity')).status, 403);
});
test('default-off flag, development preview and cross-origin writes do not change records', async () => {
  const { sqlite } = await world();
  globalThis.__COMPANY_COMPLIANCE_ENV__ = {};
  assert.equal((await get()).status, 404);
  globalThis.__COMPANY_COMPLIANCE_ENV__ = { COMPANY_COMPLIANCE_DRAFTS_ENABLED: 'true' };
  assert.equal((await post({ action: 'save_master', company, expectedVersion: 0 }, { origin: 'https://evil.test' })).status, 403);
  const preview = await route.GET(new Request(`http://localhost/api/company-compliance-drafts?entityId=${company.entityId}`));
  assert.ok(preview.status >= 400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'company_compliance_%'").get().n, 6);
});
test('immutable master versions and draft lineage reject stale versions and cross-entity records', async () => {
  const { sqlite, draft } = await draftWorld();
  assert.equal((await post({ action: 'save_master', company, expectedVersion: 0 })).status, 409);
  assert.equal((await post({ action: 'save_master', company: { ...company, entityId: 'other' }, expectedVersion: 1 })).status, 400);
  assert.equal((await post({ action: 'create_draft', meeting: { ...meeting, entityId: 'other' }, draft: { ...draftInput, id: 'bad' } })).status, 400);
  assert.equal((await post({ action: 'create_draft', meeting, draft: draftInput })).status, 409);
  assert.equal((await post({ action: 'create_draft', meeting, draft: { ...draftInput, id: 'draft-2', version: 2, supersedes: 'draft-1' } })).status, 201);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_compliance_documents').get().n, 2);
  assert.equal(draft.mode, 'draft_only');
});
test('print endpoint is authenticated, scoped, escaped and has restrictive CSP', async () => {
  await draftWorld();
  const response = await get(company.entityId, EMAIL, '&draftId=draft-1&view=print');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await response.text(), /DRAFT/);
  assert.equal((await get('other', EMAIL, '&draftId=draft-1&view=print')).status, 403);
  assert.ok((await get(company.entityId, null, '&draftId=draft-1&view=print')).status >= 400);
});
test('bounded multipart upload calculates byte hash and atomic audit; refuses incomplete or active-content PDFs', async () => {
  const { db, sqlite, draft } = await draftWorld();
  const bytes = fixturePdf();
  await store.reviewDraft(db, company.entityId, draft.id, 1, draft.checksum, 'fixture/draft-review', CHECKER);
  const metadata = { id: 'signed-1', entityId: company.entityId, draftId: draft.id, draftVersion: 1, draftChecksum: draft.checksum, localDocumentReference: `company-compliance:${company.entityId}:${draft.id}`, pageCount: 1, signers: ['dir-1'], matchesOriginal: true, completenessReviewedBy: 'forged' };
  const upload = async (input, fileBytes = bytes) => {
    const form = new FormData(); form.set('file', new File([fileBytes], 'signed.pdf', { type: 'application/pdf' })); form.set('metadata', JSON.stringify(input));
    return route.POST(new Request(`${ORIGIN}/api/company-compliance-drafts?entityId=${company.entityId}&draftId=draft-1&action=signed_copy`, { method: 'POST', headers: { origin: ORIGIN, 'oai-authenticated-user-email': EMAIL }, body: form }));
  };
  assert.equal((await upload({ ...metadata, signers: [] })).status, 400);
  assert.equal((await upload(metadata, new TextEncoder().encode('%PDF-1.4 /JavaScript invalid %%EOF'))).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_compliance_signed_copies').get().n, 0);
  const response = await upload(metadata); assert.equal(response.status, 201);
  const data = (await response.json()).data;
  assert.equal(data.copy.completenessReviewedBy, EMAIL); assert.equal(data.copy.fileChecksum.length, 64);
  const stored = sqlite.prepare('SELECT file_bytes FROM company_compliance_signed_copies').get(); assert.deepEqual(new Uint8Array(stored.file_bytes), bytes);
  assert.equal((await upload(metadata)).status, 409);
  assert.equal((await store.historyFor(db, draft)).events.length, 3);
});
test('MCA assessment remains disabled; reviewed GST routing records manual outcome, not official acceptance', async () => {
  const { db, draft } = await draftWorld();
  await store.reviewDraft(db, company.entityId, draft.id, 1, draft.checksum, 'fixture/draft-review', CHECKER);
  const uploaded = await store.saveSignedCopy(db, company.entityId, draft.id, fixturePdf(), { id: 'copy-1', entityId: company.entityId, draftId: draft.id, draftVersion: 1, draftChecksum: draft.checksum, localDocumentReference: 'private:test', pageCount: 1, signers: ['dir-1'], matchesOriginal: true }, EMAIL);
  await store.reviewSignedCopy(db, company.entityId, draft.id, 3, uploaded.copy.fileChecksum, 'fixture/copy-review', true, ['dir-1'], CHECKER);
  const assessment = { entityId: company.entityId, draftId: draft.id, draftVersion: 1, required: 'yes', reason: 'Synthetic reviewed test', authority: 'MCA', form: 'fixture', evidence: { reference: 'fixture/review', sourceUrl: 'https://www.gst.gov.in/', reviewedBy: EMAIL, reviewedOn: '2026-10-03' }, signingRequirements: 'Reviewer-verified electronic signing method', certificationRequirements: 'Reviewer-verified form-specific requirements' };
  assert.equal((await post({ action: 'assess_filing', assessment }, { suffix: '&draftId=draft-1', email: CHECKER })).status, 409);
  const routeResponse = await post({ action: 'assess_filing', assessment: { ...assessment, authority: 'GST' } }, { suffix: '&draftId=draft-1', email: CHECKER }); assert.equal(routeResponse.status, 200);
  assert.equal((await routeResponse.json()).data.route.liveFilingEnabled, false);
  assert.equal((await post({ action: 'record_outcome', expectedSequence: 2, status: 'acknowledged', reference: 'fixture-ack', note: 'Synthetic manual evidence' }, { suffix: '&draftId=draft-1', email: CHECKER })).status, 409);
  const accepted = await post({ action: 'record_outcome', expectedSequence: 5, status: 'acknowledged', reference: 'fixture-ack', note: 'Synthetic manual evidence, not portal acceptance verification' }, { suffix: '&draftId=draft-1', email: CHECKER }); assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).data.officialAcceptanceVerified, false);
});
test('saved Finance adapter is read-only, verifies checksum and never infers clean reconciliation', async () => {
  const { sqlite, db } = await world();
  sqlite.exec('CREATE TABLE gst_return_documents(id TEXT,entity_id TEXT,registration_id TEXT,period_code TEXT,version INTEGER,status TEXT,checksum TEXT,payload_json TEXT,prepared_by TEXT,reviewed_by TEXT,approval_reference TEXT)');
  const payload = JSON.stringify({ reconciliation: { note: 'Not a verified reconciliation status' } });
  sqlite.prepare('INSERT INTO gst_return_documents VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('return-1', company.entityId, 'reg-1', '2026-09', 1, 'reviewed', await checksum(payload), payload, 'fixture-maker', 'fixture-checker', 'fixture-review');
  const scope = { entityId: company.entityId, registrationId: 'reg-1', artifactId: 'return-1', period: '2026-09' };
  assert.equal((await store.readSavedFinanceReturn(db, scope)).reconciliation, 'unknown');
  assert.equal(await store.readSavedFinanceReturn(db, { ...scope, entityId: 'other' }), null);
  sqlite.prepare('UPDATE gst_return_documents SET payload_json=?').run('{}');
  assert.ok((await store.readSavedFinanceReturn(db, scope)).blockers.includes('finance_payload_checksum_mismatch'));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'company_compliance_%'").get().n, 6);
});
test('oversized JSON and malformed enums cannot persist documents', async () => {
  const { sqlite } = await draftWorld();
  assert.equal((await post({ action: 'create_draft', padding: 'x'.repeat(70 * 1024) })).status, 413);
  assert.equal((await post({ action: 'create_draft', meeting, draft: { ...draftInput, id: 'bad', kind: 'adopted' } })).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_compliance_documents').get().n, 1);
});

test('global Finance access cannot cross explicit entity grants; expired/revoked/unapproved grants deny every read', async () => {
  const { sqlite } = await world();
  for (const clause of ["status='revoked'", "expires_at='2000-01-01T00:00:00Z'", "approval_reference=''", `approved_by='${EMAIL}'`]) {
    sqlite.prepare(`UPDATE company_compliance_entity_grants SET ${clause} WHERE principal_key=?`).run(EMAIL);
    assert.equal((await get()).status, 403);
    assert.equal((await get(company.entityId, EMAIL, '&draftId=draft-1&view=print')).status, 403);
    sqlite.prepare("UPDATE company_compliance_entity_grants SET status='active',expires_at=?,approval_reference='fixture/grant',approved_by='fixture-access-owner' WHERE principal_key=?").run(new Date(Date.now()+86400000).toISOString(), EMAIL);
  }
  sqlite.prepare('DELETE FROM company_compliance_entity_grants WHERE principal_key=?').run(EMAIL);
  assert.equal((await get()).status, 403);
  assert.equal((await post({ action: 'save_master', company, expectedVersion: 0 })).status, 403);
});
test('viewer cannot mutate; makers cannot review; checker review binds actor, exact checksum and sequence', async () => {
  const { sqlite, db, draft } = await draftWorld();
  const input = { action: 'review_draft', expectedSequence: 1, expectedChecksum: draft.checksum, reference: 'fixture/draft-review', actor: 'forged' };
  assert.equal((await post(input, { suffix: '&draftId=draft-1' })).status, 403);
  sqlite.prepare("UPDATE company_compliance_entity_grants SET role='viewer' WHERE principal_key=?").run(EMAIL);
  assert.equal((await get()).status, 200); assert.equal((await post({ action: 'create_draft', meeting, draft: draftInput })).status, 403);
  assert.equal((await post({ ...input, expectedChecksum: 'stale' }, { suffix: '&draftId=draft-1', email: CHECKER })).status, 409);
  const response = await post(input, { suffix: '&draftId=draft-1', email: CHECKER }); assert.equal(response.status, 200);
  const data = (await response.json()).data; assert.equal(data.adoptedResolution, false); assert.equal(data.filedReturn, false);
  assert.equal((await store.historyFor(db, draft)).events.at(-1).actor, CHECKER);
  assert.equal((await post(input, { suffix: '&draftId=draft-1', email: CHECKER })).status, 409);
});
test('changing maker grant to checker cannot permit self-review; persisted metadata tampering fails integrity check', async () => {
  const { sqlite, draft } = await draftWorld();
  sqlite.prepare("UPDATE company_compliance_entity_grants SET role='checker' WHERE principal_key=?").run(EMAIL);
  assert.equal((await post({ action: 'review_draft', expectedSequence: 1, expectedChecksum: draft.checksum, reference: 'fixture/self' }, { suffix: '&draftId=draft-1' })).status, 403);
  sqlite.prepare('UPDATE company_compliance_documents SET draft_json=?').run(JSON.stringify({ ...draft, pageCount: 2 }));
  assert.equal((await get(company.entityId, CHECKER, '&draftId=draft-1&view=print')).status, 409);
});
test('upload is pending review, actual page count is verified and private scan download remains grant-scoped', async () => {
  const { db, sqlite, draft } = await draftWorld();
  const metadata = { id: 'copy-1', entityId: company.entityId, draftId: draft.id, draftVersion: 1, draftChecksum: draft.checksum, localDocumentReference: `company-compliance:${company.entityId}:${draft.id}`, pageCount: 1, signers: ['dir-1'], matchesOriginal: true };
  await assert.rejects(store.saveSignedCopy(db, company.entityId, draft.id, fixturePdf(), metadata, EMAIL), /reviewed_draft_required/);
  await store.reviewDraft(db, company.entityId, draft.id, 1, draft.checksum, 'fixture/draft-review', CHECKER);
  await assert.rejects(store.saveSignedCopy(db, company.entityId, draft.id, fixturePdf(2), metadata, EMAIL), /actual_page_count/);
  const uploaded = await store.saveSignedCopy(db, company.entityId, draft.id, fixturePdf(), metadata, EMAIL);
  assert.equal(uploaded.history.events.at(-1).status, 'signed_copy_pending_review'); assert.equal(uploaded.adoptedResolution, false); assert.equal(uploaded.filedReturn, false);
  assert.equal((await get(company.entityId, CHECKER, '&draftId=draft-1&view=copy')).status, 200);
  const downloaded = await get(company.entityId, CHECKER, '&draftId=draft-1&view=copy');
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), fixturePdf());
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  assert.equal((await get('other', CHECKER, '&draftId=draft-1&view=copy')).status, 403);
  await assert.rejects(store.reviewSignedCopy(db, company.entityId, draft.id, 3, uploaded.copy.fileChecksum, 'fixture/self', true, ['dir-1'], EMAIL), /maker_checker/);
  await assert.rejects(store.reviewSignedCopy(db, company.entityId, draft.id, 3, 'stale', 'fixture/review', true, ['dir-1'], CHECKER), /checksum_mismatch/);
  const result = await store.reviewSignedCopy(db, company.entityId, draft.id, 3, uploaded.copy.fileChecksum, 'fixture/review', true, ['dir-1'], CHECKER);
  assert.equal(result.history.events.at(-1).status, 'signed_copy_reviewed'); assert.equal(result.adoptedResolution, false);
  sqlite.prepare('UPDATE company_compliance_signed_copies SET file_bytes=?').run(new Uint8Array([1,2,3]));
  assert.equal((await get(company.entityId, CHECKER, '&draftId=draft-1&view=copy')).status, 409);
});
test('audit insertion failure rolls back private bytes and quota reservation', async () => {
  const { db, sqlite, draft } = await draftWorld();
  await store.reviewDraft(db, company.entityId, draft.id, 1, draft.checksum, 'fixture/review', CHECKER);
  const metadata = { id: 'copy-1', entityId: company.entityId, draftId: draft.id, draftVersion: 1, draftChecksum: draft.checksum, localDocumentReference: 'private:fixture', pageCount: 1, signers: ['dir-1'], matchesOriginal: true };
  // Inject a duplicate audit sequence inside the batch to prove rollback, not transaction isolation.
  db.onSql('INSERT INTO company_compliance_events', () => sqlite.prepare('INSERT INTO company_compliance_events VALUES (?,?,?,?)').run(company.entityId, draft.id, 3, '{}'));
  await assert.rejects(store.saveSignedCopy(db, company.entityId, draft.id, fixturePdf(), metadata, EMAIL), /UNIQUE/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_compliance_signed_copies').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_compliance_storage').get().n, 0);
  assert.equal((await store.historyFor(db, draft)).events.length, 2);
});
test('MIME mismatch and oversized chunked upload reject before private file persistence', async () => {
  const { sqlite } = await draftWorld();
  const form = new FormData(); form.set('file', new File([fixturePdf()], 'renamed.pdf', { type: 'image/png' })); form.set('metadata', '{}');
  let response = await route.POST(new Request(`${ORIGIN}/api/company-compliance-drafts?entityId=${company.entityId}&draftId=draft-1&action=signed_copy`, { method: 'POST', headers: { origin: ORIGIN, 'oai-authenticated-user-email': EMAIL }, body: form }));
  assert.equal(response.status, 400);
  response = await route.POST(new Request(`${ORIGIN}/api/company-compliance-drafts?entityId=${company.entityId}&draftId=draft-1&action=signed_copy`, { method: 'POST', headers: { origin: ORIGIN, 'oai-authenticated-user-email': EMAIL, 'content-type': 'multipart/form-data; boundary=fixture' }, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(601 * 1024)); controller.close(); } }), duplex: 'half' }));
  assert.equal(response.status, 413);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_compliance_signed_copies').get().n, 0);
});
test('private storage quota failure atomically rolls back file and audit insert', async () => {
  const { db, sqlite, draft } = await draftWorld();
  await store.reviewDraft(db, company.entityId, draft.id, 1, draft.checksum, 'fixture/review', CHECKER);
  sqlite.prepare('INSERT INTO company_compliance_storage VALUES (?,?)').run(company.entityId, 8 * 1024 * 1024);
  const metadata = { id: 'copy-1', entityId: company.entityId, draftId: draft.id, draftVersion: 1, draftChecksum: draft.checksum, localDocumentReference: 'private:fixture', pageCount: 1, signers: ['dir-1'], matchesOriginal: true };
  await assert.rejects(store.saveSignedCopy(db, company.entityId, draft.id, fixturePdf(), metadata, EMAIL), /company_compliance_quota/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_compliance_signed_copies').get().n, 0);
  assert.equal((await store.historyFor(db, draft)).events.length, 2);
  assert.equal(sqlite.prepare('SELECT used_bytes FROM company_compliance_storage').get().used_bytes, 8 * 1024 * 1024);
});
test('read-only Finance contract preserves exact payload bytes and independent review without inferring reconciliation', async () => {
  const { sqlite, db } = await world();
  sqlite.exec('CREATE TABLE gst_return_documents(id TEXT,entity_id TEXT,registration_id TEXT,period_code TEXT,version INTEGER,status TEXT,checksum TEXT,payload_json TEXT,prepared_by TEXT,reviewed_by TEXT,approval_reference TEXT)');
  sqlite.prepare('INSERT INTO gst_return_documents VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('return-2', company.entityId, 'reg-1', '2026-09', 2, 'reviewed', await checksum('{}'), '{}', 'same-maker', 'same-maker', 'fixture/review');
  const scope = { entityId: company.entityId, registrationId: 'reg-1', artifactId: 'return-2', period: '2026-09' };
  let snapshot = await store.readSavedFinanceReturn(db, scope);
  assert.equal(snapshot.contract, 'finance-saved-return-v1'); assert.equal(snapshot.status, 'draft'); assert.ok(snapshot.blockers.includes('finance_independent_review_missing')); assert.equal(snapshot.reconciliation, 'unknown');
  sqlite.prepare('UPDATE gst_return_documents SET reviewed_by=?,payload_json=?').run('independent-checker', ' {}');
  snapshot = await store.readSavedFinanceReturn(db, scope); assert.ok(snapshot.blockers.includes('finance_payload_checksum_mismatch')); assert.equal(snapshot.liveFilingEnabled, false);
});
test('legacy upload-as-review events cannot bypass the new independent review chain', async () => {
  const { db, sqlite, draft } = await draftWorld();
  await store.reviewDraft(db, company.entityId, draft.id, 1, draft.checksum, 'fixture/review', CHECKER);
  await store.saveSignedCopy(db, company.entityId, draft.id, fixturePdf(), { id: 'copy-1', entityId: company.entityId, draftId: draft.id, draftVersion: 1, draftChecksum: draft.checksum, localDocumentReference: 'private:fixture', pageCount: 1, signers: ['dir-1'], matchesOriginal: true }, EMAIL);
  sqlite.prepare('DELETE FROM company_compliance_events WHERE sequence>1').run();
  sqlite.prepare('INSERT INTO company_compliance_events VALUES (?,?,?,?)').run(company.entityId, draft.id, 2, JSON.stringify({ status: 'signed_copy_reviewed', actor: EMAIL, at: new Date().toISOString(), reference: 'legacy', note: 'Prior uploader-only attestation' }));
  await assert.rejects(store.recordDisposition(db, company.entityId, draft.id, { entityId: company.entityId, draftId: draft.id, draftVersion: 1, required: 'no', authority: 'GST', reason: 'Synthetic migration fixture', evidence: { reference: 'fixture/review', sourceUrl: 'https://www.gst.gov.in/', reviewedBy: CHECKER, reviewedOn: '2026-10-03' } }, CHECKER), /independent_signed_review_required/);
});
