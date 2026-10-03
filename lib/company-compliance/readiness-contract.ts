/**
 * Company-information intake and requirement-verification contract. Draft-only.
 *
 * Nothing in this module is a legal fact: the fact keys name what the company must supply, never a
 * value; a requirement is text a maker typed and a checker reviewed, never an obligation the system
 * asserts; readiness means "an independent reviewer verified this record against retained source
 * material and every applicability fact is known", never "ready to file" and never "all obligations
 * are covered". `filingReady` and `comprehensiveObligations` are the literal type `false`.
 */
export const INTAKE_BUNDLES = {
  corporate_profile: ['cin', 'pan', 'incorporation_date', 'financial_year_end', 'paid_up_capital', 'turnover_latest_fy', 'holding_or_subsidiary', 'inc20a_status'],
  gst_footprint: ['gstins', 'aggregate_turnover_preceding_fy', 'filing_frequency_election', 'platform_supply_model', 'passenger_transport_supply', 'gsp_engagement'],
  employer_footprint: ['headcount_by_month', 'epfo_establishment_code', 'pt_enrolment_certificate', 'pt_registration_certificate', 'partner_engagement_model'],
  payroll_applicability: ['wage_component_structure', 'wages_at_joining_bands', 'uan_aadhaar_seeding', 'gross_salary_bands', 'exemption_proofs', 'latest_ecr_filed'],
  meetings_and_events: ['board_meeting_dates', 'circulation_resolutions', 'agm_date', 'auditor_appointment', 'loans_at_31_march', 'msme_ageing', 'allotments_charges_director_changes'],
  accounts_and_authority: ['accounting_system_hosting', 'audit_trail_setting', 'signatory_resolution', 'dsc_holders', 'company_secretary_appointed'],
} as const;
export type IntakeBundle = keyof typeof INTAKE_BUNDLES;
export type FactKey = (typeof INTAKE_BUNDLES)[IntakeBundle][number];
export const FACT_KEYS: readonly FactKey[] = (Object.values(INTAKE_BUNDLES) as readonly (readonly FactKey[])[]).flat();

/** A provided fact names where it came from; an unknown fact carries nothing at all. */
export type FactEntry = { state: 'provided'; value: string; sourceReference: string } | { state: 'unknown' };
export type IntakeRecord = { entityId: string; facts: Record<FactKey, FactEntry> };
export type IntakeVersion = { version: number; record: IntakeRecord; createdBy: string; createdAt: string };
export type FactState = 'provided' | 'unknown';

export type RequirementArea = 'gst' | 'mca' | 'epf' | 'pt' | 'signing' | 'other';
export const REQUIREMENT_AREAS: readonly RequirementArea[] = ['gst', 'mca', 'epf', 'pt', 'signing', 'other'];
export type RequirementSource = { authority: string; documentIdentifier?: string; url?: string; publishedOn?: string; effectiveFrom?: string; effectiveTo?: string };
export type RequirementRecord = {
  entityId: string; id: string; version: number; supersedes?: number; area: RequirementArea; title: string;
  obligationSummary: string; source: RequirementSource; applicabilityFactKeys: FactKey[];
  checksum: string; checksumScheme: 'requirement-record-v1'; mode: 'draft_only';
};
export type RequirementInput = Omit<RequirementRecord, 'checksum' | 'checksumScheme' | 'mode'>;

export type EvidenceKind = 'official_document' | 'portal_observation' | 'secondary';
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['official_document', 'portal_observation', 'secondary'];
/** The quoted text is the retained supporting material; its checksum is computed by the server, never accepted from the caller. */
export type EvidenceInput = { kind: EvidenceKind; reference: string; sourceUrl?: string; quotedText: string; publishedOn?: string; effectiveFrom?: string; effectiveTo?: string };
export type EvidenceAttachment = EvidenceInput & { documentChecksum: string; capturedBy: string; capturedAt: string };

export type ReviewOutcome = 'verified' | 'rejected' | 'conflict';
export type ReviewPin = { requirementChecksum: string; evidenceSequence: number; evidenceChecksum: string; intakeVersion: number; factStates: Partial<Record<FactKey, FactState>> };
export type ReviewInput = { outcome: ReviewOutcome; reference: string; requirementChecksum: string; evidenceSequence: number; evidenceChecksum: string; intakeVersion: number; humanSourceReview: boolean };

export type RequirementEventStatus = 'proposed' | 'evidence_attached' | 'verified' | 'rejected' | 'conflict' | 'superseded';
export type RequirementEvent = { status: RequirementEventStatus; actor: string; at: string; reference: string; note: string; evidence?: EvidenceAttachment; pin?: ReviewPin };
export type RequirementHistory = { entityId: string; requirementId: string; version: number; events: RequirementEvent[] };

export type Readiness = { readyForInternalReview: boolean; filingReady: false; comprehensiveObligations: false; blockers: string[]; evaluatedAt: string };
export type RequirementView = { requirement: RequirementRecord; history: RequirementHistory; readiness: Readiness; current: boolean };
export type ReadinessView = { mode: 'draft_only'; intake: IntakeVersion | null; requirements: RequirementView[]; factKeys: readonly FactKey[]; bundles: typeof INTAKE_BUNDLES };
