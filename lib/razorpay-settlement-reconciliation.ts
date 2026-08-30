import { advancePaymentState } from "./financial-lifecycle";
import { paymentEnvironment, type PaymentEnvironment } from "./razorpay-client";

type Db = D1Database;
type Row = Record<string, unknown>;
type ReconItem = Record<string, unknown>;
type Env = Record<string, unknown>;

const RAZORPAY_API = "https://api.razorpay.com";
const MAX_RECON_BYTES = 1_048_576;
const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const RUN_LEASE_MS = 10 * 60 * 1000;

const text = (value: unknown) => String(value ?? "").trim();
const isTrue = (value: unknown) => text(value).toLowerCase() === "true";

function credentials(env: Env, environment: PaymentEnvironment) {
  const keyId = text(environment === "sandbox" ? env.RAZORPAY_KEY_ID_SANDBOX : env.RAZORPAY_KEY_ID);
  const keySecret = text(environment === "sandbox" ? env.RAZORPAY_KEY_SECRET_SANDBOX : env.RAZORPAY_KEY_SECRET);
  return { keyId, keySecret };
}

function providerBase(env: Env, environment: PaymentEnvironment) {
  const raw = text(env.PAWSPACE_RAZORPAY_API_BASE_URL || RAZORPAY_API).replace(/\/$/, "");
  if (raw === RAZORPAY_API) return raw;
  if (environment !== "sandbox" || !isTrue(env.PAWSPACE_PAYMENT_CONTRACT_TEST)) {
    throw new Error("Razorpay settlement-recon override is allowed only in the sandbox contract-test environment");
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Razorpay settlement-recon override URL is invalid"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Razorpay settlement-recon override must use a loopback HTTP(S) server");
  }
  return raw;
}

async function boundedBody(response: Response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_RECON_BYTES) throw new Error("Razorpay settlement-recon response exceeded the size limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RECON_BYTES) {
      await reader.cancel();
      throw new Error("Razorpay settlement-recon response exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function parseReconDate(dateKey: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error("Settlement reconciliation date must use YYYY-MM-DD");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error("Settlement reconciliation date is invalid");
  }
  return { year, month, day };
}

export async function fetchRazorpaySettlementReconDate(env: Env, dateKey: string) {
  const environment = paymentEnvironment(env);
  if (environment === "live" && !isTrue(env.PAWSPACE_PAYMENT_LIVE_APPROVED)) {
    return { connected: false as const, environment, reason: "Live Razorpay settlement reconciliation is not approved" };
  }
  const { keyId, keySecret } = credentials(env, environment);
  if (!keyId || !keySecret) {
    return { connected: false as const, environment, reason: `Razorpay ${environment} API credentials are not configured for settlement reconciliation` };
  }
  const { year, month, day } = parseReconDate(dateKey);
  const items: ReconItem[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const skip = page * PAGE_SIZE;
    const query = new URLSearchParams({
      year: String(year),
      month: String(month).padStart(2, "0"),
      day: String(day).padStart(2, "0"),
      count: String(PAGE_SIZE),
      skip: String(skip),
    });
    let response: Response;
    let body: Record<string, unknown> = {};
    try {
      response = await fetch(`${providerBase(env, environment)}/v1/settlements/recon/combined?${query.toString()}`, {
        method: "GET",
        headers: { authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`, accept: "application/json" },
        redirect: "error",
      });
      const raw = await boundedBody(response);
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        return { connected: false as const, environment, reason: "Razorpay settlement reconciliation returned invalid JSON" };
      }
    } catch (error) {
      return { connected: false as const, environment, reason: `Razorpay settlement reconciliation request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!response.ok) {
      const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
      return { connected: false as const, environment, reason: `Razorpay ${environment} settlement reconciliation failed (${response.status}): ${text(error.description || "request failed")}` };
    }
    const pageItems = Array.isArray(body.items) ? body.items.filter((item): item is ReconItem => Boolean(item && typeof item === "object" && !Array.isArray(item))) : null;
    if (!pageItems) return { connected: false as const, environment, reason: "Razorpay settlement reconciliation response has no items collection" };
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) return { connected: true as const, environment, dateKey, items };
  }
  return { connected: false as const, environment, reason: `Razorpay settlement reconciliation exceeded ${MAX_PAGES} pages for ${dateKey}` };
}

function nonNegativeInteger(value: unknown, label: string, allowNull = true) {
  if ((value === null || value === undefined || value === "") && allowNull) return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`Razorpay settlement ${label} must be a non-negative integer`);
  return numeric;
}

export async function applyRazorpaySettlementReconItems(db: Db, input: {
  environment: PaymentEnvironment;
  reconDate: string;
  items: ReconItem[];
}) {
  let settled = 0, evidenceInserted = 0, alreadySettled = 0, deferred = 0, unmatched = 0, ignoredNonPayment = 0, ignoredUnsettled = 0;
  for (const item of input.items) {
    if (text(item.type) !== "payment") { ignoredNonPayment += 1; continue; }
    if (item.settled !== true) { ignoredUnsettled += 1; continue; }
    const paymentId = text(item.entity_id);
    const settlementId = text(item.settlement_id);
    const settledAtSeconds = Number(item.settled_at);
    if (!paymentId.startsWith("pay_") || !settlementId.startsWith("setl_") || !Number.isSafeInteger(settledAtSeconds) || settledAtSeconds <= 0) {
      throw new Error("Razorpay returned a malformed settled payment reconciliation row");
    }
    const intent = await db.prepare("SELECT * FROM payment_intents WHERE provider='razorpay' AND environment=? AND gateway_payment_id=?")
      .bind(input.environment, paymentId).first<Row>();
    if (!intent) { unmatched += 1; continue; }
    const state = text(intent.state);
    if (state !== "CAPTURED" && state !== "SETTLED") { deferred += 1; continue; }
    const amountPaise = nonNegativeInteger(item.amount, "amount", false) as number;
    if (amountPaise !== Number(intent.amount_paise)) {
      throw new Error(`Razorpay settlement amount mismatch for ${paymentId}`);
    }
    const currency = text(item.currency);
    if (!currency || currency !== text(intent.currency)) {
      throw new Error(`Razorpay settlement currency mismatch for ${paymentId}`);
    }
    const now = Date.now();
    const inserted = await db.prepare(`INSERT INTO payment_settlement_reconciliations
      (id,provider,environment,payment_intent_id,gateway_payment_id,gateway_settlement_id,settlement_utr,amount_paise,credit_paise,debit_paise,fee_paise,tax_paise,currency,settled_at,recon_date,raw_payload_json,observed_at)
      VALUES (?,'razorpay',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider,environment,gateway_payment_id,gateway_settlement_id) DO NOTHING`)
      .bind(
        `PSR-${crypto.randomUUID()}`, input.environment, String(intent.id), paymentId, settlementId, text(item.settlement_utr) || null,
        amountPaise, nonNegativeInteger(item.credit, "credit"), nonNegativeInteger(item.debit, "debit"), nonNegativeInteger(item.fee, "fee"), nonNegativeInteger(item.tax, "tax"),
        currency, settledAtSeconds * 1000, input.reconDate, JSON.stringify(item), now,
      ).run();
    if (Number(inserted.meta?.changes || 0) === 1) evidenceInserted += 1;
    if (state === "SETTLED") { alreadySettled += 1; continue; }
    const transition = await advancePaymentState(db, { intentId: String(intent.id), target: "SETTLED" });
    if (transition.changed) settled += 1;
    else {
      const current = await db.prepare("SELECT state FROM payment_intents WHERE id=?").bind(String(intent.id)).first<Row>();
      if (text(current?.state) === "SETTLED") alreadySettled += 1;
      else throw new Error(`Payment ${paymentId} could not be atomically advanced to SETTLED`);
    }
  }
  return { settled, evidenceInserted, alreadySettled, deferred, unmatched, ignoredNonPayment, ignoredUnsettled };
}

function istDateKey(value: number) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function lookbackDates(asOf: number, days = 3) {
  const base = parseReconDate(istDateKey(asOf));
  const anchor = Date.UTC(base.year, base.month - 1, base.day);
  return Array.from({ length: days }, (_, index) => new Date(anchor - index * 86_400_000).toISOString().slice(0, 10));
}

export async function runRazorpaySettlementReconciliationSweep(db: Db, env: Env, input: { asOf?: number } = {}) {
  if (!isTrue(env.PAWSPACE_RAZORPAY_SETTLEMENT_RECON_ENABLED)) {
    return { configured: false, skipped: true, reason: "PAWSPACE_RAZORPAY_SETTLEMENT_RECON_ENABLED is not true" };
  }
  const asOf = input.asOf ?? Date.now();
  const environment = paymentEnvironment(env);
  if (environment === "live" && !isTrue(env.PAWSPACE_PAYMENT_LIVE_APPROVED)) {
    return { configured: true, skipped: true, environment, reason: "Live payments are not approved" };
  }
  const dateKey = istDateKey(asOf), runKey = `${environment}:${dateKey}`;
  const now = Date.now();
  const inserted = await db.prepare(`INSERT INTO razorpay_settlement_recon_runs
    (run_key,environment,status,attempts,started_at,updated_at) VALUES (?,?,'RUNNING',1,?,?) ON CONFLICT(run_key) DO NOTHING`)
    .bind(runKey, environment, now, now).run();
  if (Number(inserted.meta?.changes || 0) !== 1) {
    const prior = await db.prepare("SELECT * FROM razorpay_settlement_recon_runs WHERE run_key=?").bind(runKey).first<Row>();
    if (text(prior?.status) === "COMPLETED") {
      const previousResult = text(prior?.result_json);
      return { configured: true, environment, duplicatePrevented: true, ...(previousResult ? JSON.parse(previousResult) as Row : {}) };
    }
    const reclaimed = await db.prepare(`UPDATE razorpay_settlement_recon_runs
      SET status='RUNNING',attempts=attempts+1,last_error=NULL,started_at=?,finished_at=NULL,updated_at=?
      WHERE run_key=? AND (status='FAILED' OR (status='RUNNING' AND started_at<?))`)
      .bind(now, now, runKey, now - RUN_LEASE_MS).run();
    if (Number(reclaimed.meta?.changes || 0) !== 1) {
      return { configured: true, environment, skipped: true, inProgress: true };
    }
  }
  try {
    const aggregate = { settled: 0, evidenceInserted: 0, alreadySettled: 0, deferred: 0, unmatched: 0, ignoredNonPayment: 0, ignoredUnsettled: 0 };
    const dates = lookbackDates(asOf, 3);
    for (const reconDate of dates) {
      const fetched = await fetchRazorpaySettlementReconDate(env, reconDate);
      if (!fetched.connected) throw new Error(fetched.reason);
      const applied = await applyRazorpaySettlementReconItems(db, { environment, reconDate, items: fetched.items });
      for (const key of Object.keys(aggregate) as Array<keyof typeof aggregate>) aggregate[key] += applied[key];
    }
    const result = { dates, ...aggregate };
    await db.prepare("UPDATE razorpay_settlement_recon_runs SET status='COMPLETED',result_json=?,last_error=NULL,finished_at=?,updated_at=? WHERE run_key=?")
      .bind(JSON.stringify(result), Date.now(), Date.now(), runKey).run();
    return { configured: true, environment, duplicatePrevented: false, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.prepare("UPDATE razorpay_settlement_recon_runs SET status='FAILED',last_error=?,finished_at=?,updated_at=? WHERE run_key=?")
      .bind(message, Date.now(), Date.now(), runKey).run();
    throw error;
  }
}
