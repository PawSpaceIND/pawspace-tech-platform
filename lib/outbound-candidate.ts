import { scoreLead } from "./crm-lead-scoring-merge";
import { evaluateOutboundNextBestService, type OutboundNextBestRecommendation } from "./outbound-next-best-service";
import { decideOutboundRoute, isMarketingLifecycle, type OutboundLifecycle } from "./outbound-routing-policy";
import { ensureOutboundOrchestratorTables } from "./outbound-schema";
import type { GrowthServiceCode, ServiceHistoryFact } from "./services/pet-next-best-service";

type Db = D1Database;
type Row = Record<string, unknown>;
const DAY = 86_400_000;
const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const digits = (value: unknown) => text(value).replace(/\D/g, "");

function service(value: unknown): GrowthServiceCode | null {
  const normalized = text(value).toLowerCase();
  if (normalized.includes("groom")) return "grooming";
  if (normalized.includes("train")) return "training";
  if (normalized.includes("walk")) return "walking";
  if (normalized.includes("board")) return "boarding";
  if (normalized.includes("sitt")) return "sitting";
  if (normalized.includes("taxi")) return "taxi";
  return null;
}

async function first(db: Db, sql: string, bindings: unknown[] = []) {
  try {
    let query = db.prepare(sql);
    if (bindings.length) query = query.bind(...bindings);
    return await query.first<Row>();
  } catch {
    return null;
  }
}

async function all(db: Db, sql: string, bindings: unknown[] = []) {
  try {
    let query = db.prepare(sql);
    if (bindings.length) query = query.bind(...bindings);
    return (await query.all<Row>()).results || [];
  } catch {
    return [];
  }
}

export async function evaluateOutboundCustomer(db: Db, customer: Row, asOf: number) {
  await ensureOutboundOrchestratorTables(db);
  const customerId = text(customer.id);
  const preferences = await first(db, "SELECT marketing_consent,service_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?", [customerId]) || {};
  const lead = await first(db, "SELECT * FROM lead_work_items WHERE customer_id=? AND status NOT IN ('closed','merged') AND converted_booking_id IS NULL ORDER BY updated_at DESC LIMIT 1", [customerId]);
  let leadScore = 0;
  if (lead) {
    const scored = await scoreLead(db, text(lead.id)).catch(() => null);
    leadScore = Number(scored?.totalScore || 0);
  }

  const bookings = await all(db, "SELECT service_code,status,scheduled_end,total_amount FROM canonical_bookings WHERE customer_id=? AND status NOT IN ('cancelled','refunded','draft') ORDER BY scheduled_end DESC", [customerId]);
  const ltv = bookings.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
  const latest = bookings[0]?.scheduled_end ? Date.parse(text(bookings[0].scheduled_end)) : 0;
  const recency = latest ? Math.max(0, Math.floor((asOf - latest) / DAY)) : 999;
  const historyMap = new Map<GrowthServiceCode, { count: number; last: number }>();
  for (const booking of bookings) {
    const code = service(booking.service_code);
    if (!code) continue;
    const value = historyMap.get(code) || { count: 0, last: 0 };
    if (text(booking.status) === "completed") {
      value.count += 1;
      value.last = Math.max(value.last, Date.parse(text(booking.scheduled_end)) || 0);
    }
    historyMap.set(code, value);
  }

  const pet = await first(db, "SELECT p.id,p.species,p.breed,b.date_of_birth FROM canonical_pets p LEFT JOIN pet_birthdays b ON b.pet_id=p.id WHERE p.customer_id=? ORDER BY p.created_at LIMIT 1", [customerId]);
  const subscription = await first(db, "SELECT * FROM customer_grooming_subscriptions WHERE customer_id=? AND status IN ('active','paused') ORDER BY expires_at LIMIT 1", [customerId]);
  const recovery = await first(db, "SELECT * FROM payment_recovery_entitlements WHERE customer_id=? AND status='active' AND expires_at>? ORDER BY expires_at LIMIT 1", [customerId, asOf]);
  const control = await first(db, "SELECT control_type,scope,expires_at FROM outbound_contact_controls WHERE customer_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY CASE control_type WHEN 'dnd' THEN 1 WHEN 'wrong_number' THEN 2 ELSE 3 END,created_at DESC LIMIT 1", [customerId, asOf]);

  let next: OutboundNextBestRecommendation | null = null;
  if (pet) {
    const ageMonths = pet.date_of_birth ? Math.max(0, Math.floor((asOf - Date.parse(text(pet.date_of_birth))) / (DAY * 30.4375))) : null;
    const serviceHistory: ServiceHistoryFact[] = [...historyMap].map(([serviceCode, value]) => ({ serviceCode, completedCount: value.count, lastCompletedAt: value.last || null }));
    const statedIntent = service(lead?.service);
    next = evaluateOutboundNextBestService({
      pet: { petId: text(pet.id), species: text(pet.species), breed: text(pet.breed) || null, ageMonths },
      serviceHistory,
      statedIntent: statedIntent ? [statedIntent] : [],
      activeEntitlements: subscription ? { grooming: Math.max(0, Number(subscription.total_sessions || 0) - Number(subscription.sessions_reserved || 0) - Number(subscription.sessions_consumed || 0)) } : {},
    })[0] || null;
  }

  const grooming = historyMap.get("grooming");
  const groomingDays = grooming?.last ? Math.floor((asOf - grooming.last) / DAY) : 999;
  const callbackRequested = Boolean(lead && (/callback|call me/i.test(text(lead.last_outcome)) || (Number(lead.next_action_at || 0) > asOf && Number(lead.next_action_at || 0) < asOf + 7 * DAY)));
  let lifecycle: OutboundLifecycle = "no_action";
  let sourceKey = `none:${customerId}`;
  let targetOffer: string | null = null;
  let callbackAt: number | null = null;

  if (callbackRequested && lead) {
    lifecycle = "requested_callback";
    sourceKey = `callback:${lead.id}:${lead.next_action_at || asOf}`;
    targetOffer = "Requested callback";
    callbackAt = Number(lead.next_action_at || asOf);
  } else if (recovery) {
    lifecycle = "payment_recovery";
    sourceKey = `payment:${recovery.id}`;
    targetOffer = "Complete abandoned payment";
  } else if (subscription && Number(subscription.expires_at || 0) <= asOf + 30 * DAY) {
    lifecycle = "subscription_renewal";
    sourceKey = `renewal:${subscription.id}:${subscription.expires_at}`;
    targetOffer = "Grooming subscription renewal";
  } else if (groomingDays >= 21 && groomingDays <= 40) {
    lifecycle = "grooming_renewal";
    sourceKey = `groom:${customerId}:${grooming?.last}`;
    targetOffer = "Grooming renewal due";
  } else if (lead) {
    const leadAge = Math.floor((asOf - Math.max(Number(lead.updated_at || 0), Number(lead.assigned_at || 0))) / DAY);
    lifecycle = leadAge >= 60 && leadAge <= 180 ? "dormant_lead" : "fresh_lead";
    sourceKey = `lead:${lead.id}:${lifecycle}`;
    targetOffer = text(lead.service) || "Qualify requirement";
  } else if (recency >= 60 && recency <= 180) {
    lifecycle = "reactivation";
    sourceKey = `react:${customerId}:${latest}`;
    targetOffer = "Customer reactivation";
  } else if (next) {
    lifecycle = "cross_sell";
    sourceKey = `cross:${customerId}:${next.targetService}:${next.offerCode || "service"}`;
    targetOffer = next.offerCode === "grooming_subscription" ? "Grooming subscription" : `Next best service · ${next.targetService}`;
  }

  const hardSuppression = Boolean(control && ["dnd", "wrong_number"].includes(text(control.control_type)));
  const coolingUntil = control && text(control.control_type) === "cooling_period" && isMarketingLifecycle(lifecycle) ? Number(control.expires_at || 0) : null;
  const customerScore = Math.round((Math.min(1, ltv / 20_000) * 0.55 + Math.max(0, 1 - recency / 180) * 0.45) * 100);
  const decision = decideOutboundRoute({
    leadScore,
    customerScore,
    ltv,
    lifecycleCode: lifecycle,
    scaleIntent: ["fresh_lead", "dormant_lead", "reactivation", "cross_sell"].includes(lifecycle),
    marketingConsent: Boolean(Number(preferences.marketing_consent || 0)),
    serviceConsent: preferences.service_consent == null ? true : Boolean(Number(preferences.service_consent)),
    optedOut: Boolean(Number(preferences.opt_out || 0)) || hardSuppression,
    coolingUntil,
    phoneAvailable: digits(customer.primary_phone).length >= 8,
    nextBestService: next?.targetService || null,
    asOf,
  });
  if (decision.lane === "hold") return { lane: "hold", scored: Boolean(lead) };

  await db.prepare("INSERT INTO outbound_routing_queue (id,source_key,customer_id,lead_id,source_type,lane,priority_score,high_intent,lifecycle_code,target_offer,next_best_service,expected_revenue,ltv,callback_at,status,context_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET lane=excluded.lane,priority_score=MAX(outbound_routing_queue.priority_score,excluded.priority_score),target_offer=excluded.target_offer,next_best_service=excluded.next_best_service,ltv=excluded.ltv,callback_at=COALESCE(excluded.callback_at,outbound_routing_queue.callback_at),context_json=excluded.context_json,updated_at=excluded.updated_at")
    .bind(uid("ORQ"), sourceKey, customerId, lead ? text(lead.id) : null, lifecycle, decision.lane, decision.priorityScore, decision.highIntent ? 1 : 0, lifecycle, targetOffer, next?.targetService || null, next?.expectedRevenue ?? null, ltv, callbackAt, decision.lane === "suppressed" ? "suppressed" : "queued", JSON.stringify({ leadScore, decisionReasons: decision.reasons, nextBestReason: next?.explanation || null, journeyCode: next?.journeyCode || null, journeyStep: next?.journeyStep || null }), asOf, asOf).run();
  return { lane: decision.lane, scored: Boolean(lead) };
}
