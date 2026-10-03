import { createDraft, validateCompany, validateSignedCopy, routeSignedCopy, appendAudit, checksum, draftRecordChecksum, type CompanyMaster, type Draft, type MeetingRecord, type SignedCopy, type FilingAssessment, type AuditEvent, type FilingHistory } from './workflow';
import { inspectPdf, PDF_LIMITS } from './pdf-boundary';

type Row = Record<string, unknown>;
type Statement = { bind(...values: unknown[]): Statement; first<T = Row>(): Promise<T | null>; all<T = Row>(): Promise<{ results: T[] }>; run(): Promise<unknown> };
export type DraftDatabase = { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown> };
export class DraftError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
function fail(message: string, status = 400): never { throw new DraftError(message, status); }
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const validateId = (value: string) => { if (!/^[\w.-]{1,120}$/.test(value)) fail('invalid_id'); };
async function exists(db: DraftDatabase, table: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first());
}

/** Reads only approved business identifiers. Never SELECT * from finance/config tables. */
export async function readFinanceMaster(db: DraftDatabase, entityId: string) {
  validateId(entityId);
  if (!await exists(db, 'finance_entities')) return null;
  const row = await db.prepare("SELECT id,legal_name,country_code,status FROM finance_entities WHERE id=? AND country_code='IN' AND status='active'").bind(entityId).first();
  if (!row) return null;
  const registrations = await exists(db, 'tax_registrations')
    ? (await db.prepare("SELECT id,registration_reference,jurisdiction FROM tax_registrations WHERE entity_id=? AND registration_type='gst' AND status='active'").bind(entityId).all()).results : [];
  return { entityId: text(row.id), legalName: text(row.legal_name), recordReference: `finance_entities:${entityId}`, registrations: registrations.map(r => ({ id: text(r.id), gstin: text(r.registration_reference), jurisdiction: text(r.jurisdiction), frequency: 'unknown' as const })), missingCompanyFields: ['cin', 'pan', 'registeredOffice', 'directors'] };
}

/** Owned tables only. Called on opt-in mutations; read-only GET never creates schema. */
export async function ensureDraftTables(db: DraftDatabase) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS company_compliance_masters (entity_id TEXT NOT NULL,version INTEGER NOT NULL,record_json TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(entity_id,version))'),
    db.prepare('CREATE TABLE IF NOT EXISTS company_compliance_documents (entity_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,meeting_id TEXT NOT NULL,kind TEXT NOT NULL,draft_json TEXT NOT NULL,created_by TEXT NOT NULL,PRIMARY KEY(entity_id,id),UNIQUE(entity_id,meeting_id,kind,version))'),
    db.prepare('CREATE TABLE IF NOT EXISTS company_compliance_signed_copies (entity_id TEXT NOT NULL,id TEXT NOT NULL,draft_id TEXT NOT NULL,copy_json TEXT NOT NULL,file_bytes BLOB NOT NULL,PRIMARY KEY(entity_id,id),UNIQUE(entity_id,draft_id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS company_compliance_events (entity_id TEXT NOT NULL,draft_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(entity_id,draft_id,sequence))'),
    db.prepare("CREATE TABLE IF NOT EXISTS company_compliance_entity_grants (entity_id TEXT NOT NULL,principal_key TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','maker','checker')),status TEXT NOT NULL CHECK(status IN ('active','revoked')),expires_at TEXT NOT NULL,approved_by TEXT NOT NULL,approval_reference TEXT NOT NULL,PRIMARY KEY(entity_id,principal_key))"),
    db.prepare(`CREATE TABLE IF NOT EXISTS company_compliance_storage (entity_id TEXT PRIMARY KEY,used_bytes INTEGER NOT NULL CONSTRAINT company_compliance_quota CHECK(used_bytes>=0 AND used_bytes<=${PDF_LIMITS.entityStoredBytes}))`),
  ]);
}

export async function readWorkspace(db: DraftDatabase, entityId: string) {
  const finance = await readFinanceMaster(db, entityId);
  if (!finance) fail('active_indian_finance_entity_required', 404);
  const master = await exists(db, 'company_compliance_masters') ? await db.prepare('SELECT version,record_json FROM company_compliance_masters WHERE entity_id=? ORDER BY version DESC LIMIT 1').bind(entityId).first() : null;
  const documents = await exists(db, 'company_compliance_documents') ? (await db.prepare('SELECT draft_json FROM company_compliance_documents WHERE entity_id=? ORDER BY version DESC').bind(entityId).all()).results.map(r => JSON.parse(text(r.draft_json)) as Draft) : [];
  const events = await exists(db, 'company_compliance_events') ? (await db.prepare('SELECT draft_id,sequence,event_json FROM company_compliance_events WHERE entity_id=? ORDER BY draft_id,sequence').bind(entityId).all()).results.map(r => ({ draftId: text(r.draft_id), sequence: Number(r.sequence), ...JSON.parse(text(r.event_json)) })) : [];
  return { finance, master: master ? { version: Number(master.version), company: JSON.parse(text(master.record_json)) as CompanyMaster } : null, documents, events, mode: 'draft_only', productionReady: false, mcaRulesEnabled: false };
}

export async function saveMaster(db: DraftDatabase, company: CompanyMaster, expectedVersion: number, actor: string) {
  validateCompany(company); validateId(company.entityId);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) fail('invalid_master_version');
  const finance = await readFinanceMaster(db, company.entityId);
  if (!finance || finance.legalName !== company.legalName) fail('finance_master_mismatch');
  for (const registration of company.gstRegistrations) if (!finance.registrations.some(r => r.id === registration.id && r.gstin === registration.gstin)) fail('registration_master_mismatch');
  await ensureDraftTables(db);
  const current = await db.prepare('SELECT MAX(version) version FROM company_compliance_masters WHERE entity_id=?').bind(company.entityId).first();
  if (Number(current?.version || 0) !== expectedVersion) fail('master_version_conflict', 409);
  // Immutable version insert; the primary key rejects concurrent stale writers.
  await db.prepare('INSERT INTO company_compliance_masters VALUES (?,?,?,?,?)').bind(company.entityId, expectedVersion + 1, JSON.stringify(company), actor, new Date().toISOString()).run();
  return { version: expectedVersion + 1 };
}

export async function getDraft(db: DraftDatabase, entityId: string, id: string) {
  validateId(entityId); validateId(id);
  const row = await exists(db, 'company_compliance_documents') ? await db.prepare('SELECT draft_json FROM company_compliance_documents WHERE entity_id=? AND id=?').bind(entityId, id).first() : null;
  if (!row) fail('draft_not_found', 404);
  const draft = JSON.parse(text(row.draft_json)) as Draft;
  if (draft.id !== id || draft.entityId !== entityId || (draft.checksumScheme === 'draft-record-v1' && await draftRecordChecksum(draft) !== draft.checksum)) fail('draft_storage_integrity_mismatch', 409);
  return draft;
}
export async function readPrivateCopy(db: DraftDatabase, entityId: string, id: string) {
  await getDraft(db, entityId, id);
  const row = await db.prepare('SELECT copy_json,file_bytes FROM company_compliance_signed_copies WHERE entity_id=? AND draft_id=?').bind(entityId, id).first();
  if (!row || !(row.file_bytes instanceof Uint8Array || row.file_bytes instanceof ArrayBuffer)) fail('private_copy_missing', 404);
  const bytes = row.file_bytes instanceof ArrayBuffer ? new Uint8Array(row.file_bytes) : row.file_bytes as Uint8Array;
  const copy = JSON.parse(text(row.copy_json)) as SignedCopy;
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)), actual = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (actual !== copy.fileChecksum || bytes.length > PDF_LIMITS.bytes) fail('private_storage_integrity_mismatch', 409);
  return { bytes, copy };
}
export async function historyFor(db: DraftDatabase, draft: Draft): Promise<FilingHistory> {
  const rows = (await db.prepare('SELECT event_json FROM company_compliance_events WHERE entity_id=? AND draft_id=? ORDER BY sequence').bind(draft.entityId, draft.id).all()).results;
  return { entityId: draft.entityId, draftId: draft.id, version: draft.version, events: rows.map(r => JSON.parse(text(r.event_json)) as AuditEvent) };
}
function eventInsert(db: DraftDatabase, draft: Draft, sequence: number, event: AuditEvent) {
  return db.prepare('INSERT INTO company_compliance_events VALUES (?,?,?,?)').bind(draft.entityId, draft.id, sequence, JSON.stringify(event));
}
export async function saveDraft(db: DraftDatabase, entityId: string, meeting: MeetingRecord, input: Parameters<typeof createDraft>[2], actor: string) {
  const workspace = await readWorkspace(db, entityId);
  if (!workspace.master) fail('record_backed_company_master_required');
  if (meeting.entityId !== entityId) fail('meeting_entity_mismatch');
  validateId(input.id);
  if (input.supersedes) {
    const previous = await getDraft(db, entityId, input.supersedes);
    if (previous.version + 1 !== input.version || previous.meetingId !== meeting.id || previous.kind !== input.kind) fail('draft_lineage_conflict', 409);
  }
  const draft = await createDraft(workspace.master.company, meeting, input);
  // Preserve the exact master version used; later company edits must not rewrite prior drafts.
  draft.sourceReferences.push(`company_compliance_masters:${entityId}:${workspace.master.version}`);
  draft.checksum = await draftRecordChecksum(draft);
  const event: AuditEvent = { status: 'draft', actor, at: new Date().toISOString(), reference: draft.checksum, note: 'Record-backed draft generated; no meeting approval or government filing performed.' };
  const history = appendAudit({ entityId, draftId: draft.id, version: draft.version, events: [] }, event);
  await ensureDraftTables(db);
  await db.batch([
    db.prepare('INSERT INTO company_compliance_documents VALUES (?,?,?,?,?,?,?)').bind(entityId, draft.id, draft.version, draft.meetingId, draft.kind, JSON.stringify(draft), actor),
    eventInsert(db, draft, history.events.length, event),
  ]);
  return draft;
}

export async function reviewDraft(db: DraftDatabase, entityId: string, id: string, expectedSequence: number, expectedChecksum: string, reviewReference: string, actor: string) {
  const draft = await getDraft(db, entityId, id), history = await historyFor(db, draft);
  if (history.events.length !== expectedSequence || history.events.at(-1)?.status !== 'draft') fail('draft_review_conflict', 409);
  if (history.events[0].actor.toLowerCase() === actor.toLowerCase()) fail('maker_checker_required', 403);
  if (draft.checksumScheme !== 'draft-record-v1' || expectedChecksum !== draft.checksum || await draftRecordChecksum(draft) !== draft.checksum) fail('draft_checksum_mismatch', 409);
  const event: AuditEvent = { status: 'draft_reviewed', actor, at: new Date().toISOString(), reference: reviewReference, note: 'Independent review of draft wording and source references only; not adoption or legal filing.' };
  const next = appendAudit(history, event); await eventInsert(db, draft, next.events.length, event).run(); return { history: next, adoptedResolution: false, filedReturn: false };
}

/** Private byte retention only. Upload queues independent review; never adoption or filing. */
export async function saveSignedCopy(db: DraftDatabase, entityId: string, id: string, bytes: Uint8Array, input: Omit<SignedCopy, 'fileChecksum' | 'completenessReviewedBy'>, actor: string) {
  const draft = await getDraft(db, entityId, id);
  const inspection = await inspectPdf(bytes);
  if (inspection.pageCount !== draft.pageCount || inspection.pageCount !== input.pageCount) fail('pdf_actual_page_count_mismatch');
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  const fileChecksum = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  validateId(input.id);
  const copy = validateSignedCopy(draft, { ...input, fileChecksum, completenessReviewedBy: actor });
  const history = await historyFor(db, draft);
  if (history.events.at(-1)?.status !== 'draft_reviewed') fail('reviewed_draft_required', 409);
  const event: AuditEvent = { status: 'signed_copy_pending_review', actor, at: new Date().toISOString(), reference: fileChecksum, note: JSON.stringify({ inspection, uploaderAttestationOnly: true, adoptedResolution: false, filedReturn: false }) };
  const next = appendAudit(history, event);
  await db.batch([
    db.prepare('INSERT INTO company_compliance_signed_copies VALUES (?,?,?,?,?)').bind(entityId, copy.id, draft.id, JSON.stringify(copy), bytes),
    db.prepare('INSERT INTO company_compliance_storage(entity_id,used_bytes) SELECT ?,COALESCE(SUM(length(file_bytes)),0) FROM company_compliance_signed_copies WHERE entity_id=? ON CONFLICT(entity_id) DO UPDATE SET used_bytes=used_bytes+?').bind(entityId, entityId, bytes.length),
    eventInsert(db, draft, next.events.length, event),
  ]);
  return { copy, inspection, history: next, malwareScanPerformed: false, completenessIndependentlyReviewed: false, adoptedResolution: false, filedReturn: false };
}
export async function reviewSignedCopy(db: DraftDatabase, entityId: string, id: string, expectedSequence: number, expectedFileChecksum: string, reference: string, matchesOriginal: boolean, signers: string[], actor: string) {
  const draft = await getDraft(db, entityId, id), history = await historyFor(db, draft);
  if (history.events.length !== expectedSequence || history.events.at(-1)?.status !== 'signed_copy_pending_review') fail('signed_review_conflict', 409);
  if (history.events.at(-1)!.actor.toLowerCase() === actor.toLowerCase() || history.events[0].actor.toLowerCase() === actor.toLowerCase()) fail('maker_checker_required', 403);
  const row = await db.prepare('SELECT copy_json,file_bytes FROM company_compliance_signed_copies WHERE entity_id=? AND draft_id=?').bind(entityId, id).first();
  if (!row || !(row.file_bytes instanceof Uint8Array || row.file_bytes instanceof ArrayBuffer)) fail('private_copy_missing');
  const bytes = row.file_bytes instanceof ArrayBuffer ? new Uint8Array(row.file_bytes) : row.file_bytes as Uint8Array;
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)), actual = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  const stored = JSON.parse(text(row.copy_json)) as SignedCopy;
  if (stored.fileChecksum !== actual || expectedFileChecksum !== actual) fail('signed_file_checksum_mismatch', 409);
  const inspection = await inspectPdf(bytes); if (inspection.pageCount !== stored.pageCount) fail('pdf_actual_page_count_mismatch');
  const reviewed = validateSignedCopy(draft, { ...stored, matchesOriginal, signers, completenessReviewedBy: actor });
  const event: AuditEvent = { status: 'signed_copy_reviewed', actor, at: new Date().toISOString(), reference, note: JSON.stringify({ fileChecksum: actual, reviewed, humanVisualReview: true, adoptedResolution: false, filedReturn: false }) };
  const next = appendAudit(history, event); await eventInsert(db, draft, next.events.length, event).run();
  return { history: next, completenessIndependentlyReviewed: true, adoptedResolution: false, filedReturn: false };
}
export async function recordDisposition(db: DraftDatabase, entityId: string, id: string, assessment: FilingAssessment, actor: string) {
  const draft = await getDraft(db, entityId, id);
  const row = await db.prepare('SELECT copy_json FROM company_compliance_signed_copies WHERE entity_id=? AND draft_id=?').bind(entityId, id).first();
  if (!row) fail('reviewed_signed_copy_required');
  // MCA legal routing is disabled until authoritative verification is complete.
  if (assessment.authority === 'MCA' || !assessment.authority) fail('mca_assessment_disabled', 409);
  if (assessment.evidence?.reviewedBy !== actor) fail('assessment_reviewer_mismatch');
  const route = routeSignedCopy(draft, JSON.parse(text(row.copy_json)), assessment);
  if (route.destination === 'review_required') fail('filing_review_incomplete');
  const history = await historyFor(db, draft);
  const scanReview = history.events.slice().reverse().find(e => e.status === 'signed_copy_reviewed');
  const upload = history.events.slice().reverse().find(e => e.status === 'signed_copy_pending_review');
  if (draft.checksumScheme !== 'draft-record-v1' || !history.events.some(e => e.status === 'draft_reviewed') || !scanReview || !upload || scanReview.actor.toLowerCase() === upload.actor.toLowerCase() || scanReview.actor.toLowerCase() === history.events[0].actor.toLowerCase()) fail('independent_signed_review_required', 409);
  const event: AuditEvent = { status: route.destination === 'internal_retention' ? 'retained' : 'manual_filing_pending', actor, at: new Date().toISOString(), reference: assessment.evidence!.reference, note: JSON.stringify({ assessment, route }) };
  const next = appendAudit(history, event);
  await eventInsert(db, draft, next.events.length, event).run();
  return { route, history: next };
}
export async function recordPortalOutcome(db: DraftDatabase, entityId: string, id: string, expectedSequence: number, status: 'acknowledged' | 'rejected', reference: string, note: string, actor: string) {
  const draft = await getDraft(db, entityId, id), history = await historyFor(db, draft);
  if (history.events.length !== expectedSequence) fail('audit_version_conflict', 409);
  const event: AuditEvent = { actor, at: new Date().toISOString(), status, reference, note };
  const next = appendAudit(history, event);
  await eventInsert(db, draft, next.events.length, event).run();
  return { history: next, officialAcceptanceVerified: false };
}

/** Conservative read-only adapter: legacy reviewed state does not prove clean reconciliation. */
export async function readSavedFinanceReturn(db: DraftDatabase, scope: { entityId: string; registrationId?: string; period: string; artifactId: string }) {
  if (!scope.registrationId || !await exists(db, 'gst_return_documents')) return null;
  const row = await db.prepare('SELECT id,entity_id,registration_id,period_code,version,status,checksum,payload_json,prepared_by,reviewed_by,approval_reference FROM gst_return_documents WHERE id=? AND entity_id=? AND registration_id=? AND period_code=?').bind(scope.artifactId, scope.entityId, scope.registrationId, scope.period).first();
  if (!row) return null;
  // Verify payload hasn't changed since its checksum was saved.
  const blockers = await checksum(typeof row.payload_json === 'string' ? row.payload_json : '') === text(row.checksum) ? [] : ['finance_payload_checksum_mismatch'];
  const independent = Boolean(text(row.prepared_by) && text(row.reviewed_by) && text(row.prepared_by).toLowerCase() !== text(row.reviewed_by).toLowerCase());
  if (!independent) blockers.push('finance_independent_review_missing');
  return { contract: 'finance-saved-return-v1' as const, entityId: text(row.entity_id), registrationId: text(row.registration_id), period: text(row.period_code), artifactId: text(row.id), version: Number(row.version), checksum: text(row.checksum), preparedBy: text(row.prepared_by), reviewedBy: text(row.reviewed_by), status: row.status === 'reviewed' && independent && text(row.approval_reference) ? 'reviewed' as const : 'draft' as const, reconciliation: 'unknown' as const, blockers: [...blockers, 'entity_register_reconciliation_review_required'], sourceReferences: [`gst_return_documents:${text(row.id)}`], liveFilingEnabled: false };
}
