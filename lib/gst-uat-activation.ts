/**
 * UAT PLACEHOLDER activation of the governed gst-accounting pipeline.
 *
 * ⚠️ NON-PRODUCTION. This stands up a governed tax entity / registration / policy / classification /
 * document-series chain populated with an OBVIOUSLY FAKE GSTIN and a flat 18% classification, purely so
 * the completion → invoice pipeline can be exercised end to end on staging. It intentionally uses a
 * placeholder registration reference ("UATNONPROD00GSTIN") so nothing it produces can be mistaken for a
 * real tax invoice. Real activation must be done by finance through the governed gst-accounting config
 * actions with a real GSTIN, legally-correct per-SAC rates and a real approval reference.
 *
 * `issueUatGovernedInvoice` computes the invoice's taxable base per the UAT rules
 * (see lib/gst-uat-computation.ts) and hands it to the real gst-accounting.issueInvoice, so the 18%
 * classification produces the GST and a governed finance_invoices row is written. It is fail-safe: any
 * error is returned (not thrown), so a booking's completion never breaks because tax could not be issued.
 */
import {ensureGstAccountingTables, issueInvoice} from "./gst-accounting";
import {computeUatTaxAndPayout, type EngagementModel, type UatTaxPayout} from "./gst-uat-computation";

type Db = D1Database;

export const UAT_GST_ENTITY_ID = "uat-entity-nonprod";
export const UAT_GST_POLICY_ID = "uat-taxpol-nonprod";
export const UAT_GST_REGISTRATION_ID = "uat-taxreg-nonprod";
export const UAT_GST_DUMMY_GSTIN = "UATNONPROD00GSTIN"; // obviously fake, non-production
const UAT_SERVICE_CODES = ["grooming", "dog_training", "boarding", "pet_sitting", "pet_taxi", "dog_walking", "funeral_memorial", "funeral", "food"];
const GST_COMPONENTS = JSON.stringify([{code: "GST", rate: 18}]);

const configured = new WeakSet<Db>();

export async function ensureUatGstConfig(db: Db) {
  if (configured.has(db)) return;
  await ensureGstAccountingTables(db);
  const now = Date.now();
  const effectiveFrom = "2020-01-01"; // safely in the past so activePolicy/registration resolve today
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?)")
      .bind(UAT_GST_ENTITY_ID, "PawSpace UAT (NON-PRODUCTION)", "IN", "uat_seed", now, now, now),
    db.prepare("INSERT OR IGNORE INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,NULL,?,?,?,?)")
      .bind(UAT_GST_REGISTRATION_ID, UAT_GST_ENTITY_ID, "IN-KA", "gst", UAT_GST_DUMMY_GSTIN, effectiveFrom, "uat_seed", now, now, now),
    db.prepare("INSERT OR IGNORE INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active',?,NULL,?,?,?,?,?,?)")
      .bind(UAT_GST_POLICY_ID, UAT_GST_ENTITY_ID, 1, effectiveFrom, JSON.stringify({placeholder: true, note: "UAT non-production 18% GST"}), "UAT-PLACEHOLDER-NONPROD", "uat_seed", now, now, now),
    db.prepare("INSERT OR IGNORE INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES (?,?,?,?,?,?,?,'active',?)")
      .bind("uat-series-invoice", UAT_GST_ENTITY_ID, "invoice", "UAT-INV-", 1, 6, UAT_GST_POLICY_ID, now),
    ...UAT_SERVICE_CODES.map((service) =>
      db.prepare("INSERT OR IGNORE INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(`uat-class-${service}`, UAT_GST_POLICY_ID, service, "UAT-GST-18", GST_COMPONENTS, "customer_location", "standard", now),
    ),
  ];
  await db.batch(stmts);
  configured.add(db);
}

export type UatGovernedInvoiceResult =
  | {ok: true; financeInvoice: Record<string, unknown>; computation: UatTaxPayout}
  | {ok: false; error: string; computation?: UatTaxPayout};

/**
 * Issue a governed UAT invoice for a booking through gst-accounting.issueInvoice, using the UAT tax
 * rules to pick the taxable base. Returns the finance invoice row plus the full tax/payout computation.
 * Never throws — the caller decides how to fall back if this returns {ok:false}.
 */
export async function issueUatGovernedInvoice(
  db: Db,
  input: {
    bookingId: string;
    customerId: string;
    serviceCode: string;
    engagementModel: EngagementModel;
    gross: number;
    currency?: string;
    providerSharePercent?: number;
    packageName?: string;
    actorId: string;
  },
): Promise<UatGovernedInvoiceResult> {
  const computation = computeUatTaxAndPayout({
    serviceCode: input.serviceCode,
    engagementModel: input.engagementModel,
    gross: input.gross,
    providerSharePercent: input.providerSharePercent,
  });
  try {
    await ensureUatGstConfig(db);
    const issueDate = new Date().toISOString().slice(0, 10);
    const financeInvoice = await issueInvoice(
      db,
      {
        entityId: UAT_GST_ENTITY_ID,
        issueDate,
        sourceType: "booking",
        sourceId: input.bookingId,
        sourceEventKey: `uat-booking:${input.bookingId}:invoice`,
        customerId: input.customerId,
        currency: input.currency || "INR",
        reason: "UAT non-production placeholder invoice (18% GST, dummy GSTIN)",
        lines: [
          {
            lineKey: "1",
            description: `${input.packageName || input.serviceCode} (UAT)`,
            serviceCode: input.serviceCode,
            taxableAmount: computation.taxableBase,
          },
        ],
      },
      input.actorId,
    );
    return {ok: true, financeInvoice: (financeInvoice ?? {}) as Record<string, unknown>, computation};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : "uat_invoice_failed", computation};
  }
}
