/** Draft-only domain boundary. No network, database writes, credentials or tax computation. */
export type Evidence = { reference: string; sourceUrl: string; reviewedBy: string; reviewedOn: string };
export type CompanyMaster = {
  entityId: string; legalName: string; cin: string; pan: string; registeredOffice: string;
  directors: { id: string; name: string; din: string; recordReference: string }[];
  gstRegistrations: { id: string; gstin: string; frequency: "monthly" | "quarterly" | "unknown" }[];
  recordReference: string;
};
const required = (value: string, field: string) => { if (typeof value !== "string" || !value.trim()) throw new Error(`${field}_required`); };
function date(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("invalid_date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("invalid_date");
  return parsed;
}
function evidence(value: Evidence) {
  required(value.reference, "evidence_reference"); required(value.reviewedBy, "reviewer"); date(value.reviewedOn);
  const host = new URL(value.sourceUrl).hostname;
  if (!host.endsWith(".gov.in") && !host.endsWith(".nic.in")) throw new Error("official_source_required");
}
export function validateCompany(company: CompanyMaster) {
  for (const key of ["entityId", "legalName", "cin", "pan", "registeredOffice", "recordReference"] as const) required(company[key], key);
  if (!company.directors.length) throw new Error("director_records_required");
  const ids = new Set<string>();
  for (const director of company.directors) {
    for (const key of ["id", "name", "din", "recordReference"] as const) required(director[key], key);
    if (ids.has(director.id)) throw new Error("duplicate_director"); ids.add(director.id);
  }
}

/** A reviewed occurrence, rather than universal deadlines inferred from company type.
 * Relative deadlines require the actual event; notified overrides carry their own evidence. */
export type CalendarRule = {
  id: string; entityId: string; registrationId?: string; title: string; period: string;
  cadence: "monthly" | "quarterly" | "annual" | "event";
  applicability: "applicable" | "not_applicable" | "unknown"; basis: string;
  due: { kind: "fixed"; date: string } | { kind: "event"; eventReference?: string; eventDate?: string; daysAfter: number };
  evidence?: Evidence; override?: { date: string; evidence: Evidence };
};
export function calendar(company: CompanyMaster, rules: CalendarRule[]) {
  validateCompany(company);
  const ids = new Set<string>();
  return rules.map(rule => {
    required(rule.id, "rule_id"); required(rule.title, "rule_title"); required(rule.period, "period"); required(rule.basis, "applicability_basis");
    if (ids.has(rule.id)) throw new Error("duplicate_rule"); ids.add(rule.id);
    if (rule.entityId !== company.entityId) throw new Error("calendar_entity_mismatch");
    if (rule.registrationId && !company.gstRegistrations.some(r => r.id === rule.registrationId)) throw new Error("calendar_registration_mismatch");
    if (rule.evidence) evidence(rule.evidence);
    let dueDate: string | null = null;
    if (rule.applicability === "applicable" && rule.evidence) {
      if (rule.due.kind === "fixed") { date(rule.due.date); dueDate = rule.due.date; }
      else {
        if (!Number.isInteger(rule.due.daysAfter) || rule.due.daysAfter < 0) throw new Error("invalid_event_offset");
        if (rule.due.eventDate && rule.due.eventReference?.trim()) {
          const due = date(rule.due.eventDate); due.setUTCDate(due.getUTCDate() + rule.due.daysAfter); dueDate = due.toISOString().slice(0, 10);
        }
      }
      if (rule.override && dueDate) { evidence(rule.override.evidence); date(rule.override.date); dueDate = rule.override.date; }
    }
    return { ...rule, dueDate, state: rule.applicability === "not_applicable" && rule.evidence ? "excluded" : dueDate ? "draft_calendar" : "review_required" };
  });
}

/** Existing Finance owns return generation. This port must only READ saved artifacts.
 * Keeping their maker/checker status and reconciliation avoids marking a return ready from totals alone. */
export type FinanceSnapshot = {
  entityId: string; registrationId?: string; period: string; artifactId: string; version: number;
  checksum: string; status: "draft" | "reviewed"; reconciliation: "clean" | "mismatch" | "unknown";
  blockers: string[]; sourceReferences: string[];
};
export interface FinanceReader { readSavedReturn(scope: { entityId: string; registrationId?: string; period: string; artifactId: string }): Promise<FinanceSnapshot | null> }
export async function prepareReturn(reader: FinanceReader, scope: { entityId: string; registrationId?: string; period: string; artifactId: string }) {
  for (const key of ["entityId", "period", "artifactId"] as const) required(scope[key], key);
  const snapshot = await reader.readSavedReturn(scope);
  if (!snapshot) return { mode: "draft_only" as const, readyForReview: false, blockers: ["finance_artifact_missing"] };
  if (snapshot.entityId !== scope.entityId || snapshot.period !== scope.period || snapshot.artifactId !== scope.artifactId || snapshot.registrationId !== scope.registrationId) throw new Error("finance_scope_mismatch");
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) throw new Error("invalid_finance_version");
  required(snapshot.checksum, "finance_checksum");
  const blockers = [...snapshot.blockers];
  if (!snapshot.sourceReferences.length) blockers.push("source_records_missing");
  if (snapshot.status !== "reviewed") blockers.push("finance_review_pending");
  if (snapshot.reconciliation !== "clean") blockers.push("reconciliation_not_clean");
  return { mode: "draft_only" as const, readyForReview: blockers.length === 0, blockers, snapshot: structuredClone(snapshot) };
}

export type DecisionRecord = { id: string; text: string; recordReference: string; outcome: "proposed" | "passed" | "rejected" | "deferred" };
export type MeetingRecord = {
  id: string; entityId: string; date: string; location: string; recordReference: string;
  state: "planned" | "held"; attendance: string[]; chairId?: string; quorumConfirmed?: boolean;
  agenda: { title: string; recordReference: string }[]; decisions: DecisionRecord[];
};
export type Draft = {
  id: string; entityId: string; version: number; supersedes?: string; kind: "agenda" | "resolution" | "minutes";
  meetingId: string; sourceReferences: string[]; signers: string[]; text: string;
  pageCount: number; checksum: string; checksumScheme: "draft-record-v1"; mode: "draft_only";
};
export async function checksum(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function draftRecordChecksum(draft: Omit<Draft, 'checksum'>) {
  return checksum(JSON.stringify({ scheme: draft.checksumScheme, id: draft.id, entityId: draft.entityId, version: draft.version, supersedes: draft.supersedes || null, kind: draft.kind, meetingId: draft.meetingId, sourceReferences: draft.sourceReferences, signers: draft.signers, pageCount: draft.pageCount, text: draft.text, mode: draft.mode }));
}
export async function createDraft(company: CompanyMaster, meeting: MeetingRecord, input: {
  id: string; version: number; supersedes?: string; kind: Draft["kind"]; signers: string[]; pageCount: number;
}) : Promise<Draft> {
  validateCompany(company); required(input.id, "draft_id"); required(meeting.id, "meeting_id"); date(meeting.date);
  if (!["agenda", "resolution", "minutes"].includes(input.kind) || !["planned", "held"].includes(meeting.state)) throw new Error("invalid_document_or_meeting_kind");
  required(meeting.location, "meeting_location"); required(meeting.recordReference, "meeting_record");
  if (meeting.entityId !== company.entityId) throw new Error("meeting_entity_mismatch");
  if (!Number.isInteger(input.version) || input.version < 1 || !Number.isInteger(input.pageCount) || input.pageCount < 1) throw new Error("invalid_draft_version_or_pages");
  if ((input.version > 1) !== Boolean(input.supersedes?.trim())) throw new Error("version_lineage_required");
  const known = new Set(company.directors.map(d => d.id));
  if (!input.signers.length || new Set(input.signers).size !== input.signers.length || input.signers.some(id => !known.has(id))) throw new Error("signer_records_required");
  if (new Set(meeting.attendance).size !== meeting.attendance.length || meeting.attendance.some(id => !known.has(id))) throw new Error("invalid_attendance");
  if (!meeting.agenda.length) throw new Error("agenda_records_required");
  for (const item of meeting.agenda) { required(item.title, "agenda_title"); required(item.recordReference, "agenda_record"); }
  const decisionIds = new Set<string>();
  for (const item of meeting.decisions) {
    required(item.id, "decision_id"); required(item.text, "decision_text"); required(item.recordReference, "decision_record");
    if (!["proposed", "passed", "rejected", "deferred"].includes(item.outcome)) throw new Error("invalid_decision_outcome");
    if (decisionIds.has(item.id)) throw new Error("duplicate_decision"); decisionIds.add(item.id);
  }
  if (input.kind === "minutes" && (meeting.state !== "held" || meeting.quorumConfirmed !== true || !meeting.chairId || !meeting.attendance.includes(meeting.chairId) || !meeting.decisions.length || meeting.decisions.some(d => d.outcome === "proposed"))) throw new Error("held_meeting_records_required");
  if (input.kind === "resolution" && !meeting.decisions.length) throw new Error("explicit_decisions_required");
  if (meeting.state === "planned" && meeting.decisions.some(d => d.outcome !== "proposed")) throw new Error("held_meeting_records_required");
  if (meeting.decisions.some(d => d.outcome === "passed") && (meeting.state !== "held" || meeting.quorumConfirmed !== true || !meeting.chairId || !meeting.attendance.includes(meeting.chairId))) throw new Error("approval_evidence_required");
  const name = (id: string) => company.directors.find(d => d.id === id)!.name;
  const text = ["DRAFT — FOR REVIEW; NOT EVIDENCE OF FILING", company.legalName, `CIN: ${company.cin}`,
    `Registered office: ${company.registeredOffice}`, `${input.kind.toUpperCase()} | ${input.id} | Version ${input.version}`,
    `Meeting record: ${meeting.id} (${meeting.state}) | ${meeting.date} | ${meeting.location}`,
    ...(input.kind === "minutes" ? [`Chair: ${name(meeting.chairId!)}`, `Attendance: ${meeting.attendance.map(name).join(", ")}`] : []),
    ...(input.kind === "resolution" ? [] : meeting.agenda.map((a, i) => `${i + 1}. ${a.title}`)),
    ...(input.kind === "agenda" ? [] : meeting.decisions.map(d => `[${d.outcome.toUpperCase()}] ${d.text}`)),
    ...input.signers.map(id => `Signature: __________________  ${name(id)}  Date: __________`)].join("\n\n");
  const record: Omit<Draft, 'checksum'> = { ...input, entityId: company.entityId, meetingId: meeting.id,
    sourceReferences: [company.recordReference, meeting.recordReference, ...meeting.agenda.map(a => a.recordReference), ...meeting.decisions.map(d => d.recordReference)],
    text, checksumScheme: "draft-record-v1", mode: "draft_only" };
  return { ...record, checksum: await draftRecordChecksum(record) };
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function printableHtml(draft: Draft) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(draft.id)} — Draft</title><style>@page{size:A4;margin:20mm}body{font:12pt Georgia,serif;line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}footer{font-size:9pt}</style><body><pre>${escape(draft.text)}</pre><footer>Draft SHA-256: ${escape(draft.checksum)}. Printed pagination must be verified before signing.</footer></body></html>`;
}

export type SignedCopy = {
  id: string; entityId: string; draftId: string; draftVersion: number; draftChecksum: string;
  localDocumentReference: string; fileChecksum: string; pageCount: number; signers: string[];
  completenessReviewedBy: string; matchesOriginal: boolean;
};
export function validateSignedCopy(draft: Draft, copy: SignedCopy) {
  for (const key of ["id", "localDocumentReference", "fileChecksum", "completenessReviewedBy"] as const) required(copy[key], key);
  if (!/^[a-f0-9]{64}$/i.test(copy.fileChecksum)) throw new Error("invalid_file_checksum");
  if (copy.entityId !== draft.entityId || copy.draftId !== draft.id || copy.draftVersion !== draft.version || copy.draftChecksum !== draft.checksum) throw new Error("signed_copy_lineage_mismatch");
  if (copy.matchesOriginal !== true || copy.pageCount !== draft.pageCount || draft.signers.some(id => !copy.signers.includes(id)) || new Set(copy.signers).size !== copy.signers.length || copy.signers.some(id => !draft.signers.includes(id))) throw new Error("signed_copy_incomplete");
  return structuredClone(copy);
}
export type FilingAssessment = {
  entityId: string; draftId: string; draftVersion: number; required: "yes" | "no" | "unknown";
  authority?: "MCA" | "GST" | "INCOME_TAX"; form?: string; reason: string; evidence?: Evidence;
  signingRequirements?: string; certificationRequirements?: string;
};
const portals = { MCA: "https://www.mca.gov.in/", GST: "https://www.gst.gov.in/", INCOME_TAX: "https://www.incometax.gov.in/iec/foportal/" };
export function routeSignedCopy(draft: Draft, copy: SignedCopy, assessment: FilingAssessment) {
  validateSignedCopy(draft, copy); required(assessment.reason, "filing_reason");
  if (!["yes", "no", "unknown"].includes(assessment.required) || (assessment.authority && !["MCA", "GST", "INCOME_TAX"].includes(assessment.authority))) throw new Error("invalid_filing_assessment");
  if (assessment.entityId !== draft.entityId || assessment.draftId !== draft.id || assessment.draftVersion !== draft.version) throw new Error("filing_assessment_scope_mismatch");
  if (assessment.evidence) evidence(assessment.evidence);
  if (assessment.required === "unknown" || !assessment.evidence) return { destination: "review_required", liveFilingEnabled: false };
  if (assessment.required === "no") return { destination: "internal_retention", liveFilingEnabled: false };
  if (!assessment.authority || !assessment.form?.trim() || !assessment.signingRequirements?.trim() || !assessment.certificationRequirements?.trim()) return { destination: "review_required", liveFilingEnabled: false };
  return { destination: "manual_portal_review", portal: portals[assessment.authority], form: assessment.form,
    signingRequirements: assessment.signingRequirements, certificationRequirements: assessment.certificationRequirements,
    liveFilingEnabled: false };
}

export type AuditEvent = { actor: string; at: string; status: "draft" | "draft_reviewed" | "signed_copy_pending_review" | "signed_copy_reviewed" | "retained" | "manual_filing_pending" | "acknowledged" | "rejected"; reference: string; note: string };
export type FilingHistory = { entityId: string; draftId: string; version: number; events: AuditEvent[] };
export function appendAudit(history: FilingHistory, event: AuditEvent): FilingHistory {
  required(event.actor, "actor"); required(event.reference, "audit_reference"); required(event.note, "audit_note");
  if (!Number.isFinite(Date.parse(event.at))) throw new Error("invalid_audit_time");
  const previous = history.events.at(-1);
  const allowed: Record<AuditEvent["status"], AuditEvent["status"][]> = {
    draft: ["draft_reviewed"], draft_reviewed: ["signed_copy_pending_review"], signed_copy_pending_review: ["signed_copy_reviewed"], signed_copy_reviewed: ["retained", "manual_filing_pending"],
    retained: [], manual_filing_pending: ["acknowledged", "rejected"], acknowledged: ["rejected"], rejected: ["manual_filing_pending"],
  };
  if ((!previous && event.status !== "draft") || (previous && !allowed[previous.status].includes(event.status))) throw new Error("invalid_filing_transition");
  if (previous && Date.parse(event.at) < Date.parse(previous.at)) throw new Error("audit_time_out_of_order");
  return { ...history, events: [...structuredClone(history.events), structuredClone(event)] };
}
