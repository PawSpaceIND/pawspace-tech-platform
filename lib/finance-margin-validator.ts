import { computeOrderPayout } from "./provider-commercial-terms";

type Db = D1Database;
type Row = Record<string, unknown>;

export const MINIMUM_MARGIN_REJECTION = "System Exception: Minimum margin threshold breached. You must negotiate an alternative value or withdraw the discount.";
export const DEFAULT_MINIMUM_MARGIN_BPS = 1_000;
export const DEFAULT_MINIMUM_MARGIN_PAISE = 15_000;

export class MarginThresholdBreached extends Error {
  readonly code = "minimum_margin_threshold_breached";
  constructor() { super(MINIMUM_MARGIN_REJECTION); this.name = "MarginThresholdBreached"; }
}

export type MarginComponents = {
  baseServicePricePaise: number;
  proposedDiscountPaise: number;
  freeUpgradeCostPaise: number;
  partnerPayoutPaise: number;
  gstPaise: number;
  razorpayFeesPaise: number;
  minimumMarginBps: number;
  minimumMarginPaise: number;
};

const integer = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative integer paise`);
  return value;
};

/** Pure checkout-boundary calculation. All amounts are integer paise. */
export function calculateMargin(input: MarginComponents) {
  const base = integer(input.baseServicePricePaise, "Base service price");
  const discount = integer(input.proposedDiscountPaise, "Proposed discount");
  const upgrade = integer(input.freeUpgradeCostPaise, "Free upgrade cost");
  const payout = integer(input.partnerPayoutPaise, "Partner payout");
  const gst = integer(input.gstPaise, "GST");
  const fees = integer(input.razorpayFeesPaise, "Razorpay fees");
  const netPlatformMarginPaise = base - discount - upgrade - payout - gst - fees;
  const postOfferRevenuePaise = base - discount;
  const marginBps = postOfferRevenuePaise > 0 ? Math.floor(netPlatformMarginPaise * 10_000 / postOfferRevenuePaise) : -10_000;
  const requiredMarginPaise = Math.max(integer(input.minimumMarginPaise, "Minimum margin"), Math.ceil(postOfferRevenuePaise * input.minimumMarginBps / 10_000));
  return { ...input, postOfferRevenuePaise, netPlatformMarginPaise, marginBps, requiredMarginPaise, allowed: postOfferRevenuePaise > 0 && netPlatformMarginPaise >= requiredMarginPaise };
}

export function assertMarginFloor(input: MarginComponents) {
  const result = calculateMargin(input);
  if (!result.allowed) throw new MarginThresholdBreached();
  return result;
}

async function activePolicy(db: Db, serviceCode: string, cityId: string, asOf: number) {
  await ensureMarginPolicyTables(db);
  return db.prepare("SELECT * FROM finance_ai_margin_policies WHERE status='active' AND service_code IN (?, '') AND city_id IN (?, '') AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) ORDER BY CASE WHEN service_code=? THEN 0 ELSE 1 END,CASE WHEN city_id=? THEN 0 ELSE 1 END,version DESC LIMIT 1")
    .bind(serviceCode, cityId, asOf, asOf, serviceCode, cityId).first<Row>();
}

export async function ensureMarginPolicyTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS finance_ai_margin_policies (id TEXT PRIMARY KEY,service_code TEXT NOT NULL DEFAULT '',city_id TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',minimum_margin_bps INTEGER NOT NULL DEFAULT 1000,minimum_margin_paise INTEGER NOT NULL DEFAULT 15000,razorpay_fee_bps INTEGER NOT NULL DEFAULT 200,razorpay_fee_fixed_paise INTEGER NOT NULL DEFAULT 0,effective_from INTEGER NOT NULL,effective_to INTEGER,approved_by TEXT,approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(service_code,city_id,version))"),
    db.prepare("CREATE TABLE IF NOT EXISTS finance_ai_upgrade_costs (upgrade_code TEXT NOT NULL,service_code TEXT NOT NULL,cost_paise INTEGER NOT NULL CHECK(cost_paise>=0),version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',effective_from INTEGER NOT NULL,effective_to INTEGER,approved_by TEXT,approved_at INTEGER,PRIMARY KEY(upgrade_code,service_code,version))"),
    db.prepare("CREATE TABLE IF NOT EXISTS finance_ai_margin_decisions (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,dispatch_item_id TEXT,offer_policy_version TEXT NOT NULL,discount_bps INTEGER NOT NULL,upgrade_code TEXT,breakdown_json TEXT NOT NULL,decision TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  ]);
}

/** Resolves every monetary input from canonical booking/commercial/policy rows. */
export async function validateBookingMargin(db: Db, input: { bookingId: string; dispatchItemId?: string | null; discountBps?: number; freeUpgradeCode?: string | null; offerPolicyVersion: string; actorId: string; asOf?: number }) {
  await ensureMarginPolicyTables(db);
  const asOf = input.asOf ?? Date.now();
  const booking = await db.prepare("SELECT id,service_code,city_id,total_amount FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if (!booking) throw new Error("Canonical booking not found for margin validation");
  const discountBps = Number(input.discountBps || 0);
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) throw new Error("Discount basis points are invalid");
  const policy = await activePolicy(db, String(booking.service_code), String(booking.city_id), asOf);
  if (!policy || !policy.approved_by || !policy.approved_at) throw new Error("configuration_required: approved AI margin policy");
  const payout = await computeOrderPayout(db, { bookingId: input.bookingId, actorId: input.actorId, persist: false });
  const basePaise = Math.round(Number(booking.total_amount) * 100);
  const discountPaise = Math.floor(basePaise * discountBps / 10_000);
  let upgradeCostPaise = 0;
  const upgradeCode = String(input.freeUpgradeCode || "").trim();
  if (upgradeCode) {
    const upgrade = await db.prepare("SELECT cost_paise FROM finance_ai_upgrade_costs WHERE upgrade_code=? AND service_code=? AND status='active' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) ORDER BY version DESC LIMIT 1").bind(upgradeCode, booking.service_code, asOf, asOf).first<Row>();
    if (!upgrade) throw new Error("configuration_required: approved free-upgrade cost");
    upgradeCostPaise = Number(upgrade.cost_paise);
  }
  const postOfferPaise = basePaise - discountPaise;
  const feesPaise = Math.ceil(postOfferPaise * Number(policy.razorpay_fee_bps) / 10_000) + Number(policy.razorpay_fee_fixed_paise);
  const components: MarginComponents = {
    baseServicePricePaise: basePaise, proposedDiscountPaise: discountPaise, freeUpgradeCostPaise: upgradeCostPaise,
    partnerPayoutPaise: Math.round(payout.providerNetPayout * 100), gstPaise: Math.round((payout.platformGst + payout.pawspaceGstOnOrder) * 100),
    razorpayFeesPaise: feesPaise, minimumMarginBps: Number(policy.minimum_margin_bps), minimumMarginPaise: Number(policy.minimum_margin_paise),
  };
  let decision = "allowed", result: ReturnType<typeof calculateMargin>;
  try { result = assertMarginFloor(components); } catch (error) { decision = "blocked"; result = calculateMargin(components); await persist(); throw error; }
  await persist(); return result;
  async function persist() {
    await db.prepare("INSERT INTO finance_ai_margin_decisions (id,booking_id,dispatch_item_id,offer_policy_version,discount_bps,upgrade_code,breakdown_json,decision,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(`MARGIN-${crypto.randomUUID().slice(0, 12).toUpperCase()}`, input.bookingId, input.dispatchItemId || null, input.offerPolicyVersion, discountBps, upgradeCode || null, JSON.stringify(result), decision, asOf).run();
  }
}

/** Guarantees the validator completes before any canonical mutation callback is entered. */
export async function executeAfterMarginValidation<T>(validate: () => Promise<unknown>, execute: () => Promise<T>): Promise<T> {
  await validate();
  return execute();
}
