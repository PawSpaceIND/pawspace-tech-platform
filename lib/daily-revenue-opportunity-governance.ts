// Real daily revenue opportunity generator. Replaces a confirmed-fake generateDaily100 (100 rows
// cycling through 8 synthetic customer IDs with a rank-based formula, no real customer data at all).
//
// Combines three genuinely real sources into one ranked, targetable daily list:
//   1. Customer-scored actions from rankRevenueActions (lib/revenue-intelligence.ts) fed by
//      buildCustomer360 (lib/customer-360.ts) - repeat_due / cross_sell / win_back, already real.
//   2. Real inbound leads from lead_work_items that haven't converted yet - a real pipeline signal,
//      not fabricated. Expected revenue here is a disclosed estimate (average of the real grooming
//      catalogue's regular single-pet prices), since a lead's eventual service and package aren't
//      known yet - this is intentionally NOT presented as a precise number.
//   3. Real subscription renewals due soon, from customer_grooming_subscriptions joined to the real
//      original purchase price via source_booking_id -> canonical_bookings.total_amount. This value
//      is real, not estimated - it's exactly what the customer paid for this exact plan.
import { rankRevenueActions } from "./revenue-intelligence";
import { buildCustomer360 } from "./customer-360";
import { groomingCatalogue } from "./grooming-governance";

type Db = D1Database;
type Row = Record<string, unknown>;

export type DailyOpportunity = {
  id: string; customerId: string; leadId: string | null; opportunityType: string; reason: string;
  score: number; expectedRevenue: number; suggestedOffer: string; preferredChannel: string; owner: string;
  valueBasis: "customer_scoring_model" | "inbound_lead_catalogue_average_estimate" | "actual_subscription_price";
};

const DEFAULT_TARGET = 200_000;
const RENEWAL_WINDOW_DAYS = 14;
const day = 86_400_000;

function averageRegularSinglePrice(): number {
  const regular = groomingCatalogue.filter(item => item.offerType === "regular" && item.active);
  return Math.round(regular.reduce((sum, item) => sum + item.singlePrice, 0) / Math.max(1, regular.length));
}

export async function ensureDailyRevenueTargetTable(db: Db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS daily_revenue_targets (target_date TEXT PRIMARY KEY, target_amount REAL NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  ).run();
}

export async function currentDailyRevenueTarget(db: Db, date: string): Promise<number> {
  await ensureDailyRevenueTargetTable(db);
  const row = await db.prepare("SELECT target_amount FROM daily_revenue_targets WHERE target_date=?").bind(date).first<Row>();
  return row ? Number(row.target_amount) : DEFAULT_TARGET;
}

export async function setDailyRevenueTarget(db: Db, input: { date: string; targetAmount: number; actorId: string }) {
  if (!Number.isFinite(input.targetAmount) || input.targetAmount <= 0) throw new Error("Target amount must be a positive number");
  await ensureDailyRevenueTargetTable(db);
  const now = Date.now();
  await db.prepare(
    "INSERT INTO daily_revenue_targets (target_date,target_amount,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(target_date) DO UPDATE SET target_amount=excluded.target_amount,updated_by=excluded.updated_by,updated_at=excluded.updated_at"
  ).bind(input.date, input.targetAmount, input.actorId, now).run();
  return { date: input.date, targetAmount: input.targetAmount };
}

async function inboundLeadOpportunities(db: Db): Promise<DailyOpportunity[]> {
  const estimate = averageRegularSinglePrice();
  const leads = await db.prepare(
    "SELECT id,customer_id,service,owner FROM lead_work_items WHERE status IN ('active','qualified') AND converted_booking_id IS NULL AND opt_out=0"
  ).all<Row>();
  return leads.results.map(row => ({
    id: `DRO-LEAD-${row.id}`, customerId: String(row.customer_id), leadId: String(row.id),
    opportunityType: "inbound_lead", reason: `Open inbound lead for ${row.service} - not yet converted`,
    score: 70, expectedRevenue: estimate, suggestedOffer: `Follow up on ${row.service} enquiry`,
    preferredChannel: "whatsapp", owner: String(row.owner || "Unassigned"),
    valueBasis: "inbound_lead_catalogue_average_estimate" as const,
  }));
}

async function subscriptionRenewalOpportunities(db: Db, now: number): Promise<DailyOpportunity[]> {
  const tableCheck = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_grooming_subscriptions'").first<Row>();
  if (!tableCheck) return [];
  const windowEnd = now + RENEWAL_WINDOW_DAYS * day;
  const subs = await db.prepare(
    "SELECT s.id,s.customer_id,s.expires_at,s.total_sessions,s.sessions_consumed,b.total_amount FROM customer_grooming_subscriptions s LEFT JOIN canonical_bookings b ON b.id=s.source_booking_id WHERE s.status='active' AND s.expires_at<=? AND s.expires_at>=?"
  ).bind(windowEnd, now).all<Row>();
  return subs.results.map(row => {
    const daysToExpiry = Math.max(0, Math.floor((Number(row.expires_at) - now) / day));
    return {
      id: `DRO-RENEW-${row.id}`, customerId: String(row.customer_id), leadId: null,
      opportunityType: "renewal", reason: `Subscription renews in ${daysToExpiry} day${daysToExpiry === 1 ? "" : "s"}`,
      score: daysToExpiry <= 3 ? 90 : 75, expectedRevenue: Number(row.total_amount || 0),
      suggestedOffer: "Renew existing grooming plan", preferredChannel: "whatsapp", owner: "Unassigned",
      valueBasis: "actual_subscription_price" as const,
    };
  });
}

export async function generateRealDailyOpportunities(db: Db, input: { date: string; actorId: string; now?: number }) {
  const now = input.now ?? Date.now();
  const [customer360Records, leadOpps, renewalOpps] = await Promise.all([
    buildCustomer360(db),
    inboundLeadOpportunities(db),
    subscriptionRenewalOpportunities(db, now),
  ]);
  const scoredActions = rankRevenueActions(customer360Records, now)
    .filter(action => action.status === "ready")
    .map(action => ({
      id: action.id, customerId: action.customerId, leadId: null, opportunityType: action.opportunityType,
      reason: action.reason, score: action.score, expectedRevenue: action.expectedRevenue,
      suggestedOffer: action.reason, preferredChannel: action.preferredChannel, owner: action.owner,
      valueBasis: "customer_scoring_model" as const,
    }));
  const combined = [...renewalOpps, ...scoredActions, ...leadOpps].sort((a, b) => b.score - a.score || b.expectedRevenue - a.expectedRevenue);
  const target = await currentDailyRevenueTarget(db, input.date);
  let runningTotal = 0;
  const withinTarget: DailyOpportunity[] = [];
  for (const item of combined) {
    withinTarget.push(item);
    runningTotal += item.expectedRevenue;
    if (runningTotal >= target) break;
  }
  return { opportunities: withinTarget.length ? withinTarget : combined, target, projectedTotal: withinTarget.reduce((s, i) => s + i.expectedRevenue, 0), sourceCounts: { customerScored: scoredActions.length, inboundLeads: leadOpps.length, renewals: renewalOpps.length } };
}
