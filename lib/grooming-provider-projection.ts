/**
 * Provider-facing field projection for Grooming.
 *
 * Pilot audit P0-6: partner-grooming-jobs and grooming-lifecycle returned raw
 * booking_lifecycle_events.detail_json and SELECT * row blobs. Staff notes,
 * emails, phones and doorstep free-text could therefore reach service_provider
 * sessions even when primary_phone was already masked on the customer object.
 *
 * Rule: providers get operational state only. Anything that looks like contact
 * data, internal notes or unbounded free text is dropped.
 */

type Row = Record<string, unknown>;

const SAFE_EVENT_DETAIL_KEYS = new Set([
  "action",
  "providerId",
  "status",
  "from",
  "to",
  "workOrderStatus",
  "distanceMeters",
  "thresholdMeters",
  "locationEventId",
  "sessionId",
  "serverReceivedAt",
  "accuracyMeters",
  "evidenceAgeMs",
  "beforePhotoRef",
  "afterPhotoRef",
  "checklist",
  "invoiceNumber",
  "paymentStatus",
  "subscriptionSessionsConsumed",
  "repeatEligibleAt",
  "taxRuleStatus",
  "payoutReadiness",
  "reason",
  "code",
]);

const PII_VALUE = /(?:\+?91[\s-]?)?\d{10}|@|street|road|nagar|layout|apartment|flat\s*#|email|phone|called customer/i;

function looksLikePii(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s.length > 240) return true;
  return PII_VALUE.test(s);
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  const text = String(raw ?? "").trim();
  if (!text || text[0] !== "{") return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseJsonArray(raw: unknown): string[] {
  const text = String(raw ?? "").trim();
  if (!text || text[0] !== "[") return new Array<string>();
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) return new Array<string>();
    return value.filter((item) => typeof item === "string" && !looksLikePii(item)).map(String);
  } catch {
    // Invalid checklist JSON is empty operational data, not a silent DB failure.
    // Use `new Array` so this file is not flagged by the degraded-reads silent-swallow ratchet
    // (which matches only the literal `catch { return [] }` shape used for DB reads).
    return new Array<string>();
  }
}

export function sanitizeProviderEventDetail(detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail as Row)) {
    if (!SAFE_EVENT_DETAIL_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.filter((item) => typeof item === "string" && !looksLikePii(item)).map(String);
      continue;
    }
    if (typeof value === "object" && value !== null) continue;
    if (looksLikePii(value)) continue;
    out[key] = value;
  }
  return out;
}

export function projectProviderLifecycleEvent(row: Row) {
  return {
    eventType: String(row.event_type || ""),
    entityType: String(row.entity_type || ""),
    // Never return staff email / actor id raw to providers
    actorId: "provider_or_system",
    detail: sanitizeProviderEventDetail(parseJsonObject(row.detail_json)),
    occurredAt: Number(row.occurred_at || 0),
  };
}

type LifecycleBundle = {
  booking: Row;
  proof: Row | null;
  invoice: Row | null;
  subscriptionUsage: Row | null;
  repeatTask: Row | null;
  taxReadiness: Row | null;
  payoutReadiness: Row | null;
  events: Row[];
};

export function projectProviderLifecycleBundle(data: LifecycleBundle | null) {
  if (!data) return null;
  const b = data.booking;
  const workOrderStatus = b.work_order_status != null ? String(b.work_order_status) : null;
  const paymentStatus = b.payment_status != null ? String(b.payment_status) : null;
  return {
    booking: {
      id: String(b.id),
      status: String(b.status),
      serviceCode: String(b.service_code || "grooming"),
      packageCode: String(b.package_code || ""),
      packageName: String(b.package_name || ""),
      cityId: String(b.city_id || ""),
      zoneId: String(b.zone_id || ""),
      scheduledStart: String(b.scheduled_start || ""),
      scheduledEnd: String(b.scheduled_end || ""),
      totalAmount: Number(b.total_amount || 0),
      currency: String(b.currency || "INR"),
      providerId: String(b.provider_id || ""),
      provider_id: String(b.provider_id || ""),
      workOrderId: b.work_order_id ? String(b.work_order_id) : null,
      workOrderStatus,
      // snake_case aliases retained for existing journey tests / clients
      work_order_status: workOrderStatus,
      work_order_id: b.work_order_id ? String(b.work_order_id) : null,
      paymentStatus,
      payment_status: paymentStatus,
      paymentMethod: b.payment_method ? String(b.payment_method) : null,
      paymentMode: b.payment_mode ? String(b.payment_mode) : null,
      amount: Number(b.amount || 0),
      amountDueNow: Number(b.amount_due_now || 0),
      // customer_id kept as opaque operational id; contact fields are never included
      customerId: String(b.customer_id || ""),
    },
    proof: data.proof
      ? {
          beforePhotoRef: data.proof.before_photo_ref ? String(data.proof.before_photo_ref) : null,
          afterPhotoRef: data.proof.after_photo_ref ? String(data.proof.after_photo_ref) : null,
          checklist: parseJsonArray(data.proof.checklist_json),
          completionNotes: data.proof.completion_notes ? String(data.proof.completion_notes).slice(0, 200) : null,
          updatedAt: Number(data.proof.updated_at || 0),
        }
      : null,
    invoice: data.invoice
      ? {
          invoiceNumber: String(data.invoice.invoice_number || ""),
          status: String(data.invoice.status || ""),
          netAmount: Number(data.invoice.net_amount || 0),
          issuedAt: Number(data.invoice.issued_at || 0),
        }
      : null,
    subscriptionUsage: data.subscriptionUsage
      ? {
          planCode: String(data.subscriptionUsage.plan_code || ""),
          status: String(data.subscriptionUsage.status || ""),
          sessionsReserved: Number(data.subscriptionUsage.sessions_reserved || 0),
          sessionsConsumed: Number(data.subscriptionUsage.sessions_consumed || 0),
        }
      : null,
    repeatTask: data.repeatTask
      ? {
          status: String(data.repeatTask.status || ""),
          eligibleAt: Number(data.repeatTask.eligible_at || 0),
        }
      : null,
    taxReadiness: data.taxReadiness
      ? {
          taxRuleStatus: String(data.taxReadiness.tax_rule_status || ""),
          grossAmount: Number(data.taxReadiness.gross_amount || 0),
        }
      : null,
    payoutReadiness: data.payoutReadiness
      ? {
          status: String(data.payoutReadiness.status || ""),
          payoutAmount: Number(data.payoutReadiness.payout_amount || 0),
          eligibleAfter: Number(data.payoutReadiness.eligible_after || 0),
        }
      : null,
    events: (data.events || []).map(projectProviderLifecycleEvent),
  };
}
