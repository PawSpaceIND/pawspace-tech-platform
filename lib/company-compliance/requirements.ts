import { DraftError, readFinanceMaster, type DraftDatabase } from './store';
import { checksum } from './workflow';
import { factStates, readIntake } from './intake';
import { EVIDENCE_KINDS, FACT_KEYS, INTAKE_BUNDLES, REQUIREMENT_AREAS, type EvidenceAttachment, type EvidenceInput, type FactKey, type IntakeVersion, type Readiness, type ReadinessView, type RequirementEvent, type RequirementEventStatus, type RequirementHistory, type RequirementInput, type RequirementRecord, type RequirementView, type ReviewInput } from './readiness-contract';

/**
 * Requirement verification and readiness. A requirement is text a maker proposed; evidence is retained
 * quoted source material whose checksum the server computes; verification is an independent checker's
 * event that pins the exact requirement version, evidence checksum and intake version it looked at.
 * Readiness is re-derived on every read and fails closed on any drift, unknown fact, missing or
 * expired source range, conflict or supersession. It is never filing readiness.
 */
type Row = Record<string, unknown>;
function fail(message: string, status = 400): never { throw new DraftError(message, status); }
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const validateId = (value: string) => { if (!/^[\w.-]{1,120}$/.test(value)) fail('invalid_id'); };
const isoDate = (value: string, field: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`invalid_date:${field}`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`invalid_date:${field}`);
  return value;
};
async function exists(db: DraftDatabase, table: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first());
}
export const EVIDENCE_LIMITS = { quotedText: 4000, reference: 200, title: 200, obligationSummary: 2000 } as const;

export async function ensureRequirementTables(db: DraftDatabase) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS company_compliance_requirements (entity_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,record_json TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(entity_id,id,version))'),
    db.prepare('CREATE TABLE IF NOT EXISTS company_compliance_requirement_reviews (entity_id TEXT NOT NULL,requirement_id TEXT NOT NULL,version INTEGER NOT NULL,sequence INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(entity_id,requirement_id,version,sequence))'),
  ]);
}

export async function requirementChecksum(record: Omit<RequirementRecord, 'checksum'>) {
  return checksum(JSON.stringify({ scheme: record.checksumScheme, entityId: record.entityId, id: record.id, version: record.version, supersedes: record.supersedes ?? null, area: record.area, title: record.title, obligationSummary: record.obligationSummary, source: record.source, applicabilityFactKeys: record.applicabilityFactKeys, mode: record.mode }));
}

/** Validates shape only. No obligation, rate, threshold or deadline is derived from the text. */
export function validateRequirement(input: RequirementInput): RequirementInput {
  if (!input || typeof input !== 'object') fail('requirement_required');
  validateId(text(input.entityId)); validateId(text(input.id));
  if (!Number.isInteger(input.version) || input.version < 1) fail('invalid_requirement_version');
  if ((input.version > 1) !== (input.supersedes !== undefined)) fail('requirement_lineage_required');
  if (input.supersedes !== undefined && input.supersedes !== input.version - 1) fail('requirement_lineage_conflict', 409);
  if (!REQUIREMENT_AREAS.includes(input.area)) fail('invalid_requirement_area');
  const title = text(input.title), obligationSummary = text(input.obligationSummary);
  if (!title || title.length > EVIDENCE_LIMITS.title) fail('requirement_title_required');
  if (!obligationSummary || obligationSummary.length > EVIDENCE_LIMITS.obligationSummary) fail('obligation_summary_required');
  const source = input.source && typeof input.source === 'object' ? input.source : fail('requirement_source_required');
  const authority = text(source.authority); if (!authority || authority.length > EVIDENCE_LIMITS.reference) fail('source_authority_required');
  const clean: RequirementInput['source'] = { authority };
  if (text(source.documentIdentifier)) clean.documentIdentifier = text(source.documentIdentifier).slice(0, EVIDENCE_LIMITS.reference);
  if (text(source.url)) { try { const url = new URL(text(source.url)); if (url.protocol !== 'https:' || url.username || url.password) fail('invalid_source_url'); clean.url = url.toString(); } catch (error) { if (error instanceof DraftError) throw error; fail('invalid_source_url'); } }
  for (const key of ['publishedOn', 'effectiveFrom', 'effectiveTo'] as const) if (text(source[key])) clean[key] = isoDate(text(source[key]), key);
  if (clean.effectiveFrom && clean.effectiveTo && clean.effectiveTo < clean.effectiveFrom) fail('invalid_effective_range');
  if (!Array.isArray(input.applicabilityFactKeys) || !input.applicabilityFactKeys.length) fail('applicability_fact_keys_required');
  const keys = [...new Set(input.applicabilityFactKeys)];
  if (keys.length !== input.applicabilityFactKeys.length || keys.some(key => !FACT_KEYS.includes(key))) fail('invalid_applicability_fact_key');
  return { entityId: text(input.entityId), id: text(input.id), version: input.version, ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}), area: input.area, title, obligationSummary, source: clean, applicabilityFactKeys: keys as FactKey[] };
}

export async function validateEvidence(input: EvidenceInput, actor: string): Promise<EvidenceAttachment> {
  if (!input || typeof input !== 'object') fail('evidence_required');
  if (!EVIDENCE_KINDS.includes(input.kind)) fail('invalid_evidence_kind');
  const reference = text(input.reference); if (!reference || reference.length > EVIDENCE_LIMITS.reference) fail('evidence_reference_required');
  const quotedText = typeof input.quotedText === 'string' ? input.quotedText.trim() : '';
  // The retained material itself is required; a checksum typed by the caller is never accepted as proof.
  if (!quotedText || quotedText.length > EVIDENCE_LIMITS.quotedText) fail('retained_quoted_text_required');
  const attachment: EvidenceAttachment = { kind: input.kind, reference, quotedText, documentChecksum: await checksum(quotedText), capturedBy: actor, capturedAt: new Date().toISOString() };
  if (text(input.sourceUrl)) {
    let url: URL; try { url = new URL(text(input.sourceUrl)); } catch { fail('invalid_source_url'); }
    if (url.protocol !== 'https:' || url.username || url.password) fail('invalid_source_url');
    const host = url.hostname;
    if (input.kind === 'official_document' && (host === 'gov.in' || !(host.endsWith('.gov.in') || host.endsWith('.nic.in')))) fail('official_source_required');
    attachment.sourceUrl = url.toString();
  } else if (input.kind === 'official_document') fail('official_source_required');
  for (const key of ['publishedOn', 'effectiveFrom', 'effectiveTo'] as const) if (text(input[key])) attachment[key] = isoDate(text(input[key]), key);
  if (attachment.effectiveFrom && attachment.effectiveTo && attachment.effectiveTo < attachment.effectiveFrom) fail('invalid_effective_range');
  return attachment;
}

const SOURCE_DATE_FIELDS = ['publishedOn', 'effectiveFrom', 'effectiveTo'] as const;
type SourceDateField = (typeof SOURCE_DATE_FIELDS)[number];
/**
 * Resolves the dates readiness is judged on. A date the requirement record states is authoritative for
 * that record version; retained evidence may only supplement a date the record leaves unknown. When
 * both are known and differ, that is a source-date conflict: it is reported, never resolved by
 * preferring either side, and the maker must supersede the requirement and obtain a fresh review.
 */
export function resolveSourceDates(record: Pick<RequirementRecord, 'source'>, evidence: Pick<EvidenceAttachment, SourceDateField> | undefined) {
  const dates: Partial<Record<SourceDateField, string>> = {}, conflicts: string[] = [];
  for (const field of SOURCE_DATE_FIELDS) {
    const stated = record.source[field], retained = evidence?.[field];
    if (stated && retained && stated !== retained) conflicts.push(`source_date_conflict:${field}`);
    const value = stated || retained; if (value) dates[field] = value;
  }
  return { dates, conflicts };
}

const transitions: Record<RequirementEventStatus, RequirementEventStatus[]> = {
  proposed: ['evidence_attached', 'superseded'], evidence_attached: ['evidence_attached', 'verified', 'rejected', 'conflict', 'superseded'],
  verified: ['conflict', 'superseded'], rejected: ['evidence_attached', 'superseded'], conflict: ['evidence_attached', 'superseded'], superseded: [],
};
export function appendRequirementEvent(history: RequirementHistory, event: RequirementEvent): RequirementHistory {
  if (!text(event.actor) || !text(event.reference) || !text(event.note)) fail('audit_fields_required');
  if (!Number.isFinite(Date.parse(event.at))) fail('invalid_audit_time');
  const previous = history.events.at(-1);
  if ((!previous && event.status !== 'proposed') || (previous && !transitions[previous.status].includes(event.status))) fail('invalid_requirement_transition', 409);
  if (previous && Date.parse(event.at) < Date.parse(previous.at)) fail('audit_time_out_of_order');
  return { ...history, events: [...structuredClone(history.events), structuredClone(event)] };
}

export async function getRequirement(db: DraftDatabase, entityId: string, id: string, version: number): Promise<RequirementRecord> {
  validateId(entityId); validateId(id);
  if (!Number.isInteger(version) || version < 1) fail('invalid_requirement_version');
  const row = await exists(db, 'company_compliance_requirements') ? await db.prepare('SELECT record_json FROM company_compliance_requirements WHERE entity_id=? AND id=? AND version=?').bind(entityId, id, version).first<Row>() : null;
  if (!row) fail('requirement_not_found', 404);
  const record = JSON.parse(text(row.record_json)) as RequirementRecord;
  if (record.entityId !== entityId || record.id !== id || record.version !== version || record.checksumScheme !== 'requirement-record-v1' || await requirementChecksum(record) !== record.checksum) fail('requirement_storage_integrity_mismatch', 409);
  return record;
}
export async function requirementHistory(db: DraftDatabase, record: RequirementRecord): Promise<RequirementHistory> {
  const rows = await exists(db, 'company_compliance_requirement_reviews') ? (await db.prepare('SELECT event_json FROM company_compliance_requirement_reviews WHERE entity_id=? AND requirement_id=? AND version=? ORDER BY sequence').bind(record.entityId, record.id, record.version).all<Row>()).results : [];
  return { entityId: record.entityId, requirementId: record.id, version: record.version, events: rows.map(row => JSON.parse(text(row.event_json)) as RequirementEvent) };
}
function eventInsert(db: DraftDatabase, record: RequirementRecord, sequence: number, event: RequirementEvent) {
  return db.prepare('INSERT INTO company_compliance_requirement_reviews VALUES (?,?,?,?,?)').bind(record.entityId, record.id, record.version, sequence, JSON.stringify(event));
}
async function latestVersion(db: DraftDatabase, entityId: string, id: string) {
  const row = await exists(db, 'company_compliance_requirements') ? await db.prepare('SELECT MAX(version) version FROM company_compliance_requirements WHERE entity_id=? AND id=?').bind(entityId, id).first<Row>() : null;
  return Number(row?.version || 0);
}

export async function proposeRequirement(db: DraftDatabase, entityId: string, input: RequirementInput, actor: string) {
  validateId(entityId);
  if (!input || input.entityId !== entityId) fail('requirement_entity_mismatch');
  const clean = validateRequirement(input);
  if (clean.version !== 1) fail('requirement_lineage_required');
  if (!await readFinanceMaster(db, entityId)) fail('active_indian_finance_entity_required', 404);
  await ensureRequirementTables(db);
  if (await latestVersion(db, entityId, clean.id)) fail('requirement_exists', 409);
  const record: RequirementRecord = { ...clean, checksumScheme: 'requirement-record-v1', mode: 'draft_only', checksum: '' };
  record.checksum = await requirementChecksum(record);
  const event: RequirementEvent = { status: 'proposed', actor, at: new Date().toISOString(), reference: record.checksum, note: 'Requirement text proposed by the maker; nothing is verified and no obligation is asserted.' };
  appendRequirementEvent({ entityId, requirementId: record.id, version: record.version, events: [] }, event);
  await db.batch([
    db.prepare('INSERT INTO company_compliance_requirements VALUES (?,?,?,?,?,?)').bind(entityId, record.id, record.version, JSON.stringify(record), actor, event.at),
    eventInsert(db, record, 1, event),
  ]);
  return record;
}

export async function attachRequirementEvidence(db: DraftDatabase, entityId: string, id: string, version: number, input: EvidenceInput, actor: string) {
  const record = await getRequirement(db, entityId, id, version), history = await requirementHistory(db, record);
  const evidence = await validateEvidence(input, actor);
  const event: RequirementEvent = { status: 'evidence_attached', actor, at: evidence.capturedAt, reference: evidence.documentChecksum, note: `Retained ${evidence.kind} quoted text attached by the maker; an independent checker must still review it against the source.`, evidence };
  const next = appendRequirementEvent(history, event);
  await eventInsert(db, record, next.events.length, event).run();
  return { evidenceSequence: next.events.length, documentChecksum: evidence.documentChecksum, history: next };
}

/** Checker identity comes from the authenticated actor. The maker who proposed the version or captured the evidence cannot review it. */
export async function reviewRequirement(db: DraftDatabase, entityId: string, id: string, version: number, expectedSequence: number, input: ReviewInput, actor: string) {
  const record = await getRequirement(db, entityId, id, version), history = await requirementHistory(db, record);
  if (!input || typeof input !== 'object') fail('review_required');
  if (history.events.length !== expectedSequence) fail('requirement_review_conflict', 409);
  if (!['verified', 'rejected', 'conflict'].includes(input.outcome)) fail('invalid_review_outcome');
  if (input.humanSourceReview !== true) fail('human_source_review_required');
  const reference = text(input.reference); if (!reference || reference.length > EVIDENCE_LIMITS.reference) fail('review_reference_required');
  if (history.events[0].actor.toLowerCase() === actor.toLowerCase()) fail('maker_checker_required', 403);
  if (!Number.isInteger(input.evidenceSequence) || input.evidenceSequence < 1 || input.evidenceSequence > history.events.length) fail('evidence_sequence_required');
  const evidenceEvent = history.events[input.evidenceSequence - 1];
  if (evidenceEvent.status !== 'evidence_attached' || !evidenceEvent.evidence) fail('evidence_sequence_required');
  if (evidenceEvent.actor.toLowerCase() === actor.toLowerCase()) fail('maker_checker_required', 403);
  if (input.requirementChecksum !== record.checksum) fail('requirement_checksum_mismatch', 409);
  const retained = await checksum(evidenceEvent.evidence.quotedText);
  if (retained !== evidenceEvent.evidence.documentChecksum || input.evidenceChecksum !== retained) fail('evidence_checksum_mismatch', 409);
  const intake = await readIntake(db, entityId);
  if (!intake) fail('intake_required');
  if (intake.version !== input.intakeVersion) fail('intake_version_mismatch', 409);
  const states = factStates(intake, record.applicabilityFactKeys);
  if (input.outcome === 'verified') {
    if (evidenceEvent.evidence.kind !== 'official_document') fail('official_evidence_required');
    if (record.applicabilityFactKeys.some(key => states[key] !== 'provided')) fail('applicability_facts_unknown');
    const { conflicts } = resolveSourceDates(record, evidenceEvent.evidence);
    if (conflicts.length) fail(conflicts[0], 409);
  }
  const event: RequirementEvent = { status: input.outcome, actor, at: new Date().toISOString(), reference, note: input.outcome === 'verified' ? 'Independent human review of the retained quoted text against the cited official source. Internal readiness only; not filing readiness, legal advice or proof that all obligations are covered.' : input.outcome === 'conflict' ? 'Reviewer found the retained material conflicting with the source or another record.' : 'Reviewer rejected the retained material.', pin: { requirementChecksum: record.checksum, evidenceSequence: input.evidenceSequence, evidenceChecksum: retained, intakeVersion: intake.version, factStates: states } };
  const next = appendRequirementEvent(history, event);
  await eventInsert(db, record, next.events.length, event).run();
  return { history: next, readiness: await requirementReadiness(record, next, intake, new Date(), true), filingReady: false as const };
}

export async function supersedeRequirement(db: DraftDatabase, entityId: string, id: string, replacement: RequirementInput, actor: string) {
  const current = await latestVersion(db, entityId, id);
  if (!current) fail('requirement_not_found', 404);
  const previous = await getRequirement(db, entityId, id, current), history = await requirementHistory(db, previous);
  if (!replacement || replacement.entityId !== entityId || replacement.id !== id) fail('requirement_entity_mismatch');
  const clean = validateRequirement(replacement);
  if (clean.version !== current + 1 || clean.supersedes !== current) fail('requirement_lineage_conflict', 409);
  const record: RequirementRecord = { ...clean, checksumScheme: 'requirement-record-v1', mode: 'draft_only', checksum: '' };
  record.checksum = await requirementChecksum(record);
  const at = new Date().toISOString();
  const superseded: RequirementEvent = { status: 'superseded', actor, at, reference: record.checksum, note: `Superseded by version ${record.version}; any verification of this version no longer applies.` };
  const proposed: RequirementEvent = { status: 'proposed', actor, at, reference: record.checksum, note: 'Replacement requirement text proposed by the maker; nothing is verified.' };
  const closed = appendRequirementEvent(history, superseded);
  appendRequirementEvent({ entityId, requirementId: id, version: record.version, events: [] }, proposed);
  await db.batch([
    eventInsert(db, previous, closed.events.length, superseded),
    db.prepare('INSERT INTO company_compliance_requirements VALUES (?,?,?,?,?,?)').bind(entityId, id, record.version, JSON.stringify(record), actor, at),
    eventInsert(db, record, 1, proposed),
  ]);
  return record;
}

/** Pure, fail-closed evaluation. Every blocker is named; readiness is never filing readiness. */
export async function requirementReadiness(record: RequirementRecord, history: RequirementHistory, intake: IntakeVersion | null, now: Date, current: boolean): Promise<Readiness> {
  const blockers: string[] = [], today = now.toISOString().slice(0, 10);
  // The history must belong to this exact entity, requirement and version; a mismatched caller context is never trusted.
  if (history.entityId !== record.entityId || history.requirementId !== record.id || history.version !== record.version) blockers.push('history_scope_mismatch');
  if (!current) blockers.push('requirement_superseded');
  if (record.checksumScheme !== 'requirement-record-v1' || await requirementChecksum(record) !== record.checksum) blockers.push('requirement_checksum_drift');
  const last = history.events.at(-1);
  if (!last || last.status !== 'verified' || !last.pin) blockers.push(last?.status === 'conflict' ? 'requirement_conflict' : last?.status === 'superseded' ? 'requirement_superseded' : 'requirement_not_verified');
  const pin = last?.status === 'verified' ? last.pin : undefined;
  const evidenceEvent = pin ? history.events[pin.evidenceSequence - 1] : undefined;
  const evidence = evidenceEvent?.status === 'evidence_attached' ? evidenceEvent.evidence : undefined;
  if (pin) {
    if (pin.requirementChecksum !== record.checksum) blockers.push('requirement_checksum_drift');
    if (!evidence) blockers.push('evidence_missing');
    else {
      if (await checksum(evidence.quotedText) !== evidence.documentChecksum || pin.evidenceChecksum !== evidence.documentChecksum) blockers.push('evidence_checksum_drift');
      if (evidence.kind !== 'official_document') blockers.push('evidence_not_official');
      if (evidenceEvent && (evidenceEvent.actor.toLowerCase() === last!.actor.toLowerCase() || history.events[0].actor.toLowerCase() === last!.actor.toLowerCase())) blockers.push('independent_review_missing');
    }
  }
  if (!intake) blockers.push('intake_missing');
  else {
    if (intake.record.entityId !== record.entityId) blockers.push('entity_mismatch');
    if (pin && pin.intakeVersion !== intake.version) blockers.push('intake_version_changed');
    for (const key of record.applicabilityFactKeys) {
      if (intake.record.facts[key]?.state !== 'provided') blockers.push(`fact_unknown:${key}`);
      if (pin && pin.factStates[key] !== 'provided') blockers.push(`fact_not_provided_at_review:${key}`);
    }
  }
  // Dates: the record's stated dates govern; pinned evidence (or, before any review, the latest retained evidence) may only fill gaps, never override.
  const latestAttached = [...history.events].reverse().find(event => event.status === 'evidence_attached' && event.evidence)?.evidence;
  const { dates, conflicts } = resolveSourceDates(record, evidence ?? latestAttached);
  blockers.push(...conflicts);
  const { publishedOn, effectiveFrom, effectiveTo } = dates;
  if (!publishedOn) blockers.push('publication_date_unknown'); else if (publishedOn > today) blockers.push('publication_in_future');
  if (!effectiveFrom) blockers.push('effective_from_unknown'); else if (effectiveFrom > today) blockers.push('effective_not_started');
  if (effectiveTo && effectiveTo < today) blockers.push('effective_expired');
  if (evidence && publishedOn && evidence.capturedAt.slice(0, 10) < publishedOn) blockers.push('evidence_captured_before_publication');
  return { readyForInternalReview: blockers.length === 0, filingReady: false, comprehensiveObligations: false, blockers: [...new Set(blockers)], evaluatedAt: now.toISOString() };
}

/** Read-only view for GET. Never creates schema. */
export async function readReadiness(db: DraftDatabase, entityId: string): Promise<ReadinessView> {
  validateId(entityId);
  const intake = await readIntake(db, entityId), requirements: RequirementView[] = [], now = new Date();
  if (await exists(db, 'company_compliance_requirements')) {
    const rows = (await db.prepare('SELECT id,version,record_json FROM company_compliance_requirements WHERE entity_id=? ORDER BY id,version').bind(entityId).all<Row>()).results;
    const latest = new Map<string, number>();
    for (const row of rows) latest.set(text(row.id), Math.max(latest.get(text(row.id)) || 0, Number(row.version)));
    for (const row of rows) {
      const record = await getRequirement(db, entityId, text(row.id), Number(row.version)), history = await requirementHistory(db, record), current = latest.get(record.id) === record.version;
      requirements.push({ requirement: record, history, readiness: await requirementReadiness(record, history, intake, now, current), current });
    }
  }
  return { mode: 'draft_only', intake, requirements, factKeys: FACT_KEYS, bundles: INTAKE_BUNDLES };
}
