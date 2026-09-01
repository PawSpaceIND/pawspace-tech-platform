import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const phase = String(process.env.PROVIDER_CERT_PHASE || "").trim();
const certKey = String(process.env.PROVIDER_CERT_KEY || "").trim().toLowerCase();
const base = String(process.env.STAGING_URL || "").replace(/\/$/, "");
const cfAccount = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const cfToken = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const dbId = String(process.env.STAGING_D1_ID || "").trim();
const accessCode = String(process.env.PAWSPACE_UAT_ACCESS_CODE || "").trim();
const razorKey = String(process.env.RAZORPAY_KEY_ID_SANDBOX || "").trim();
const razorSecret = String(process.env.RAZORPAY_KEY_SECRET_SANDBOX || "").trim();
const expectedSha = "d5d99ebf6223437e42793b1f261f27d5c8005e7f";
const amountPaise = 11_800;
const taxablePaise = 10_000;
const evidencePath = `provider-certification-${certKey}-${phase}.json`;

if (!["prepare", "finalize"].includes(phase)) throw new Error("provider certification phase must be prepare or finalize");
if (!/^[a-z0-9-]{6,48}$/.test(certKey)) throw new Error("provider certification key is invalid");
for (const [name, value] of Object.entries({ STAGING_URL: base, CLOUDFLARE_ACCOUNT_ID: cfAccount, CLOUDFLARE_API_TOKEN: cfToken, STAGING_D1_ID: dbId, PAWSPACE_UAT_ACCESS_CODE: accessCode, RAZORPAY_KEY_ID_SANDBOX: razorKey, RAZORPAY_KEY_SECRET_SANDBOX: razorSecret })) {
  if (!value) throw new Error(`${name} is required`);
}
if (!razorKey.startsWith("rzp_test_")) throw new Error("provider certification refuses non-test Razorpay credentials");
if (base !== "https://pawspace-staging.karthik-fce.workers.dev") throw new Error("provider certification refuses a non-isolated staging origin");

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const safeJson = async (response) => { try { return await response.json(); } catch { return null; } };
const cookieOf = (response) => String(response.headers.get("set-cookie") || "").split(";")[0];
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function d1(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccount)}/d1/database/${encodeURIComponent(dbId)}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfToken}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await safeJson(response);
  if (!response.ok || body?.success !== true || body?.result?.[0]?.success !== true) {
    const reason = body?.errors?.[0]?.message || body?.result?.[0]?.error || `HTTP ${response.status}`;
    throw new Error(`staging D1 query failed: ${reason}`);
  }
  return body.result[0].results || [];
}
const one = async (sql, params = []) => (await d1(sql, params))[0] || null;

async function razor(path, init = {}) {
  const response = await fetch(`https://api.razorpay.com${path}`, {
    ...init,
    redirect: "error",
    headers: { authorization: `Basic ${Buffer.from(`${razorKey}:${razorSecret}`).toString("base64")}`, "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await safeJson(response);
  if (!response.ok) throw new Error(`Razorpay Test API ${response.status}: ${body?.error?.description || "request failed"}`);
  return body;
}

async function app(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { origin: base, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await safeJson(response);
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${body?.error || body?.configurationKey || "request failed"}`);
  return { body, response };
}

async function staffLogin(email) {
  const { response } = await app("/api/staging-login", { method: "POST", body: JSON.stringify({ action: "login", code: accessCode, email }) });
  const cookie = cookieOf(response);
  assert(cookie, `staging sign-in did not issue a cookie for ${email}`);
  return cookie;
}

function testPhone() {
  const suffix = BigInt(`0x${createHash("sha256").update(certKey).digest("hex").slice(0, 16)}`) % 1_000_000_000n;
  return `9${suffix.toString().padStart(9, "0")}`;
}

async function customerLogin(phone) {
  const requested = await app("/api/customer-otp", { method: "POST", body: JSON.stringify({ action: "request", phone }) });
  const challengeId = String(requested.body?.data?.challengeId || "");
  const code = String(requested.body?.data?.sandboxCode || "");
  assert(challengeId && /^\d{6}$/.test(code), "sandbox customer OTP was not issued");
  const verified = await app("/api/customer-otp", { method: "POST", body: JSON.stringify({ action: "verify", challengeId, code, name: "Provider Certification Customer", cityId: "blr", installId: `provider-cert-${certKey}` }) });
  const cookie = cookieOf(verified.response);
  assert(cookie && verified.body?.data?.customerId, "sandbox customer session was not issued");
  return { cookie, customerId: String(verified.body.data.customerId) };
}

async function postAs(path, body, cookie) {
  return (await app(path, { method: "POST", headers: { cookie }, body: JSON.stringify(body) })).body;
}

async function eventually(label, operation, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; }
    catch (error) { last = error; }
    await delay(3_000);
  }
  throw new Error(`${label} was not observed from the real provider${last ? `: ${last.message}` : ""}`);
}

async function ensureCertificationTable() {
  await d1("CREATE TABLE IF NOT EXISTS provider_certification_runs (cert_key TEXT PRIMARY KEY,expected_sha TEXT NOT NULL,status TEXT NOT NULL,plan_code TEXT,provider_plan_id TEXT,customer_id TEXT,phone TEXT,booking_id TEXT,entitlement_id TEXT,contract_id TEXT,provider_subscription_id TEXT,authorization_url TEXT,cycle_id TEXT,charge_event_id TEXT,payment_id TEXT,refund_case_id TEXT,refund_id TEXT,refund_event_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
}

async function prepare() {
  await ensureCertificationTable();
  const prior = await one("SELECT * FROM provider_certification_runs WHERE cert_key=?", [certKey]);
  if (prior?.authorization_url) {
    const evidence = { ok: true, phase, certKey, expectedSha, stagingUrl: base, authorizationUrl: prior.authorization_url, providerSubscriptionId: prior.provider_subscription_id, reused: true };
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    return evidence;
  }

  const founder = await staffLogin("founder@pawspace.in");
  await app("/api/gst-accounting", { headers: { cookie: founder } });
  const phone = testPhone();
  const customer = await customerLogin(phone);
  const tag = certKey.replace(/[^a-z0-9]/g, "").slice(-16).toUpperCase();
  const entityId = `CERT-ENTITY-${tag}`;
  const registrationId = `CERT-REG-${tag}`;
  const policyId = `CERT-POLICY-${tag}`;
  const planCode = `PROVIDER_CERT_${tag}`;
  const bookingId = `CERT-BOOKING-${tag}`;
  const entitlementId = `CERT-ENTITLEMENT-${tag}`;
  const reason = "Razorpay Test provider certification";

  await postAs("/api/gst-accounting", { action: "save_entity", id: entityId, legalName: "PawSpace Provider Certification UAT", countryCode: "IN", reason }, founder);
  await postAs("/api/gst-accounting", { action: "approve_entity", id: entityId, reason }, founder);
  await postAs("/api/gst-accounting", { action: "save_registration", id: registrationId, entityId, jurisdiction: "Karnataka", registrationType: "GSTIN", registrationReference: `29TEST${tag.slice(0, 8)}1Z5`, effectiveFrom: "2026-01-01", reason }, founder);
  await postAs("/api/gst-accounting", { action: "approve_registration", id: registrationId, reason }, founder);
  await postAs("/api/gst-accounting", { action: "save_policy", id: policyId, entityId, version: 1, effectiveFrom: "2026-01-01", policy: { certification: true, rate: 18 }, reason }, founder);
  await postAs("/api/gst-accounting", { action: "approve_policy", id: policyId, approvalReference: `CERT-${tag}`, reason }, founder);
  await postAs("/api/gst-accounting", { action: "save_classification", id: `CERT-CLASS-${tag}`, policyId, serviceCode: "grooming", classificationCode: "SAC-9997-UAT", taxComponents: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }], placeOfSupplyRule: "customer_location", inputTaxRule: "uat_only", reason }, founder);
  for (const documentType of ["invoice", "credit_note"]) {
    await postAs("/api/gst-accounting", { action: "save_series", id: `CERT-SERIES-${documentType}-${tag}`, entityId, documentType, prefix: `${documentType === "invoice" ? "INV" : "CN"}-${tag}-`, nextNumber: 1, padding: 4, policyId, reason }, founder);
  }

  const existingPlan = await one("SELECT provider_plan_id FROM subscription_billing_plans WHERE plan_code=?", [planCode]).catch(() => null);
  const providerPlan = existingPlan?.provider_plan_id
    ? await razor(`/v1/plans/${encodeURIComponent(existingPlan.provider_plan_id)}`)
    : await razor("/v1/plans", { method: "POST", body: JSON.stringify({ period: "monthly", interval: 1, item: { name: `PawSpace certification ${tag}`, amount: amountPaise, currency: "INR", description: "Isolated Test Mode recurring lifecycle certification" }, notes: { pawspace_certification_key: certKey, expected_sha: expectedSha } }) });
  assert(/^plan_[A-Za-z0-9]+$/.test(String(providerPlan?.id || "")), "Razorpay Test plan was not created");

  const now = Date.now();
  const start = new Date(now + 86_400_000).toISOString();
  const end = new Date(now + 90_000_000).toISOString();
  await d1("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await d1("CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await d1("CREATE TABLE IF NOT EXISTS grooming_subscription_purchase_snapshots (subscription_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,city_id TEXT NOT NULL,zone_id TEXT,plan_code TEXT NOT NULL,catalogue_version TEXT NOT NULL,config_json TEXT NOT NULL,created_at INTEGER NOT NULL)");
  await d1("INSERT OR IGNORE INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-cert','grooming','provider-cert','Provider Certification','CERT-GROUP-'||?,'CERT-PROVIDER',?,?,'completed','customer_app',118,'INR','{}',?,?,?)", [bookingId, `provider-cert-${certKey}`, customer.customerId, tag, start, end, customer.customerId, now, now]);
  await d1("INSERT OR IGNORE INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES (?,?,?,'provider-cert',2,0,0,'active',?,?,?,'provider-cert-v1',?,?)", [entitlementId, customer.customerId, planCode, now, now + 365 * 86_400_000, bookingId, now, now]);
  await d1("INSERT OR IGNORE INTO grooming_subscription_purchase_snapshots (subscription_id,booking_id,city_id,zone_id,plan_code,catalogue_version,config_json,created_at) VALUES (?,?,'blr','blr-cert',?,'provider-cert-v1',?,?)", [entitlementId, bookingId, planCode, JSON.stringify({ sessions: 2, validityValue: 1, validityUnit: "months" }), now]);

  await postAs("/api/subscription-billing-admin", { action: "save_plan", planCode, providerPlanId: providerPlan.id, serviceCode: "grooming", financeEntityId: entityId, chargeAmountPaise: amountPaise, invoiceTaxablePaise: taxablePaise, currency: "INR", totalCycles: 2, trialDays: 0, graceDays: 3, cityId: "blr", intervalPeriod: "monthly", intervalCount: 1 }, founder);
  await eventually("local approval of the provider-verified plan", async () => {
    try { return await postAs("/api/subscription-billing-admin", { action: "approve_plan", planCode }, founder); }
    catch { return null; }
  }, 60_000).catch(async error => {
    const local = await one("SELECT provider_plan_id,charge_amount_paise,currency,interval_period,interval_count,status FROM subscription_billing_plans WHERE plan_code=?", [planCode]);
    const remote = await razor(`/v1/plans/${encodeURIComponent(providerPlan.id)}`);
    throw new Error(`${error.message}; sanitized local=${JSON.stringify(local)} remote=${JSON.stringify({ id: remote.id, amount: remote.item?.amount, currency: remote.item?.currency, period: remote.period, interval: remote.interval })}`);
  });
  const started = await postAs("/api/subscription-billing", { action: "start", customerId: customer.customerId, sourceBookingId: bookingId, entitlementSubscriptionId: entitlementId, planCode }, customer.cookie);
  const authorizationUrl = String(started.authorizationUrl || "");
  assert(/^https:\/\/(?:rzp\.io|(?:[^/]+\.)?razorpay\.com)\//.test(authorizationUrl), "validated Razorpay authorization URL was not returned");
  const contractId = String(started.id || "");
  const providerSubscriptionId = String(started.provider_subscription_id || "");
  assert(contractId && /^sub_[A-Za-z0-9]+$/.test(providerSubscriptionId), "subscription identities were not persisted");

  await d1("INSERT INTO provider_certification_runs (cert_key,expected_sha,status,plan_code,provider_plan_id,customer_id,phone,booking_id,entitlement_id,contract_id,provider_subscription_id,authorization_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [certKey, expectedSha, "awaiting_mandate", planCode, providerPlan.id, customer.customerId, phone, bookingId, entitlementId, contractId, providerSubscriptionId, authorizationUrl, now, Date.now()]);
  const evidence = { ok: true, phase, certKey, expectedSha, stagingUrl: base, authorizationUrl, providerSubscriptionId, contractId, amountPaise, currency: "INR", mode: "test", next: "Complete the Razorpay mandate authentication at authorizationUrl" };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  return evidence;
}

async function chargeSnapshot(state, cycle) {
  const eventId = String(cycle.provider_event_id);
  const row = await one(`SELECT
    (SELECT COUNT(*) FROM subscription_billing_cycles WHERE contract_id=?) cycles,
    (SELECT COUNT(*) FROM subscription_billing_events WHERE provider_event_id=?) billing_events,
    (SELECT COUNT(*) FROM journal_transactions WHERE source_event_id IN (?,?)) journals,
    (SELECT COUNT(*) FROM finance_invoices WHERE source_event_key=?) invoices,
    (SELECT COUNT(*) FROM subscription_entitlement_grants WHERE cycle_id=?) grants,
    (SELECT COUNT(*) FROM subscription_wallet_events WHERE idempotency_key=?) wallet_events,
    (SELECT COUNT(*) FROM gateway_webhook_events WHERE provider='razorpay' AND event_id=?) inbox_events,
    (SELECT total_sessions FROM customer_grooming_subscriptions WHERE id=?) total_sessions`, [state.contract_id, eventId, `subscription:${eventId}:capture`, `subscription:${eventId}:deferred`, `subscription:${eventId}:invoice`, cycle.id, `subscription-renewal:${cycle.id}`, eventId, state.entitlement_id]);
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, Number(value)]));
}

async function replay(eventId) {
  const inbox = await one("SELECT raw_payload,signature,processing_status FROM gateway_webhook_events WHERE provider='razorpay' AND event_id=?", [eventId]);
  assert(inbox?.raw_payload && inbox?.signature && inbox.processing_status === "PROCESSED", `signed provider event ${eventId} is not processed`);
  const response = await fetch(`${base}/api/razorpay-webhook`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-event-id": eventId, "x-razorpay-signature": String(inbox.signature) }, body: String(inbox.raw_payload), signal: AbortSignal.timeout(30_000) });
  const body = await safeJson(response);
  assert(response.ok && body?.ok === true && body?.duplicate === true, `signed replay ${eventId} was not accepted as a duplicate`);
}

async function finalize() {
  await ensureCertificationTable();
  const state = await one("SELECT * FROM provider_certification_runs WHERE cert_key=?", [certKey]);
  assert(state?.status === "awaiting_mandate", "provider certification is not awaiting mandate authentication");
  const cycle = await eventually("signed subscription.charged webhook", async () => {
    const row = await one("SELECT * FROM subscription_billing_cycles WHERE contract_id=? ORDER BY created_at DESC LIMIT 1", [state.contract_id]);
    return row?.accounting_status === "completed" ? row : null;
  });
  assert(Number(cycle.amount_paise) === amountPaise, "provider charge amount is not the certified amount");
  const subscription = await razor(`/v1/subscriptions/${encodeURIComponent(state.provider_subscription_id)}`);
  const payment = await razor(`/v1/payments/${encodeURIComponent(cycle.provider_payment_id)}`);
  assert(["active", "authenticated", "completed"].includes(String(subscription.status)), `provider subscription status is ${subscription.status}`);
  assert(payment.status === "captured" && Number(payment.amount) === amountPaise, "Razorpay Test payment is not captured for the certified amount");

  const beforeChargeReplay = await chargeSnapshot(state, cycle);
  assert(beforeChargeReplay.cycles === 1 && beforeChargeReplay.billing_events === 1 && beforeChargeReplay.journals === 2 && beforeChargeReplay.invoices === 1 && beforeChargeReplay.grants === 1 && beforeChargeReplay.wallet_events === 1 && beforeChargeReplay.inbox_events === 1 && beforeChargeReplay.total_sessions === 4, "charge exactly-once invariants failed before replay");
  await replay(String(cycle.provider_event_id));
  const afterChargeReplay = await chargeSnapshot(state, cycle);
  assert(JSON.stringify(beforeChargeReplay) === JSON.stringify(afterChargeReplay), "charge replay created a second financial or entitlement effect");

  const customer = await customerLogin(String(state.phone));
  assert(customer.customerId === state.customer_id, "customer identity changed during provider certification");
  const requested = await postAs("/api/subscription-billing", { action: "request_refund", contractId: state.contract_id, cycleId: cycle.id, amountPaise, reason: "Full unused Test Mode lifecycle refund" }, customer.cookie);
  const refundCaseId = String(requested.id || "");
  assert(refundCaseId, "maker refund request was not created");
  const finance = await staffLogin("anjali.finance33@tkpetcare.in");
  const approved = await postAs("/api/subscription-billing-admin", { action: "approve_refund", refundCaseId }, finance);
  assert(approved.status === "approved" && approved.requested_by !== approved.approved_by, "maker/checker approval separation failed");
  const executed = await postAs("/api/subscription-billing-admin", { action: "execute_refund", refundCaseId }, finance);
  const refundId = String(executed.gateway_refund_id || "");
  assert(/^rfnd_[A-Za-z0-9]+$/.test(refundId), "real Razorpay Test refund id was not persisted");

  const refund = await eventually("signed refund.processed webhook", async () => {
    const providerRefund = await razor(`/v1/refunds/${encodeURIComponent(refundId)}`).catch(() => null);
    const row = await one("SELECT r.*,p.provider_event_id FROM subscription_refund_cases r LEFT JOIN subscription_provider_refunds p ON p.gateway_refund_id=r.gateway_refund_id WHERE r.id=?", [refundCaseId]).catch(() => null);
    return providerRefund?.status === "processed" && row?.status === "processed" && row?.provider_event_id ? { providerRefund, row } : null;
  });
  const refundEventId = String(refund.row.provider_event_id);
  const beforeRefundReplay = await one(`SELECT
    (SELECT COUNT(*) FROM subscription_refund_cases WHERE id=? AND status='processed') refund_cases,
    (SELECT COUNT(*) FROM subscription_provider_refunds WHERE gateway_refund_id=?) provider_refunds,
    (SELECT COUNT(*) FROM finance_adjustment_documents WHERE source_event_key=?) credit_notes,
    (SELECT COUNT(*) FROM journal_transactions WHERE source_event_id=?) refund_journals,
    (SELECT COUNT(*) FROM gateway_webhook_events WHERE provider='razorpay' AND event_id=?) inbox_events`, [refundCaseId, refundId, `subscription:${refundEventId}:credit-note`, `subscription:${refundEventId}:refund`, refundEventId]);
  assert(Object.values(beforeRefundReplay || {}).every(value => Number(value) === 1), "refund exactly-once invariants failed before replay");
  await replay(refundEventId);
  const afterRefundReplay = await one(`SELECT
    (SELECT COUNT(*) FROM subscription_refund_cases WHERE id=? AND status='processed') refund_cases,
    (SELECT COUNT(*) FROM subscription_provider_refunds WHERE gateway_refund_id=?) provider_refunds,
    (SELECT COUNT(*) FROM finance_adjustment_documents WHERE source_event_key=?) credit_notes,
    (SELECT COUNT(*) FROM journal_transactions WHERE source_event_id=?) refund_journals,
    (SELECT COUNT(*) FROM gateway_webhook_events WHERE provider='razorpay' AND event_id=?) inbox_events`, [refundCaseId, refundId, `subscription:${refundEventId}:credit-note`, `subscription:${refundEventId}:refund`, refundEventId]);
  assert(JSON.stringify(beforeRefundReplay) === JSON.stringify(afterRefundReplay), "refund replay created a second accounting or entitlement effect");

  const final = await one(`SELECT
    cy.status cycle_status,cy.accounting_status,
    r.status refund_status,r.requested_by,r.approved_by,r.amount_paise refund_amount_paise,
    a.status allocation_status,a.credits allocation_credits,
    g.credits_granted,g.refund_reserved_credits,g.refunded_credits,g.refunded_paise,
    s.total_sessions,s.sessions_reserved,s.sessions_consumed
    FROM subscription_billing_cycles cy
    JOIN subscription_refund_cases r ON r.cycle_id=cy.id
    JOIN subscription_refund_entitlement_allocations a ON a.refund_case_id=r.id
    JOIN subscription_entitlement_grants g ON g.cycle_id=cy.id
    JOIN customer_grooming_subscriptions s ON s.id=g.entitlement_subscription_id
    WHERE cy.id=? AND r.id=?`, [cycle.id, refundCaseId]);
  assert(final?.cycle_status === "refunded" && final.accounting_status === "completed" && final.refund_status === "processed" && final.allocation_status === "processed", "final provider/accounting state is not reconciled");
  assert(final.requested_by !== final.approved_by, "final maker/checker identities are not distinct");
  assert(Number(final.refund_amount_paise) === amountPaise && Number(final.allocation_credits) === 2 && Number(final.credits_granted) === 2 && Number(final.refund_reserved_credits) === 0 && Number(final.refunded_credits) === 2 && Number(final.refunded_paise) === amountPaise, "refund entitlement reconciliation does not match the provider amount");
  assert(Number(final.total_sessions) === 2 && Number(final.sessions_reserved) === 0 && Number(final.sessions_consumed) === 0, "final entitlement balance did not return to the pre-renewal baseline");
  const journals = await d1("SELECT jt.source_event_id,SUM(CASE WHEN je.direction='DEBIT' THEN je.amount_paise ELSE 0 END) debits,SUM(CASE WHEN je.direction='CREDIT' THEN je.amount_paise ELSE 0 END) credits FROM journal_transactions jt JOIN journal_entries je ON je.transaction_id=jt.id WHERE jt.source_event_id IN (?,?,?) GROUP BY jt.source_event_id ORDER BY jt.source_event_id", [`subscription:${cycle.provider_event_id}:capture`, `subscription:${cycle.provider_event_id}:deferred`, `subscription:${refundEventId}:refund`]);
  assert(journals.length === 3 && journals.every(row => Number(row.debits) === Number(row.credits) && Number(row.debits) === amountPaise), "final journals are not three balanced exactly-once postings");

  await d1("UPDATE provider_certification_runs SET status='complete',cycle_id=?,charge_event_id=?,payment_id=?,refund_case_id=?,refund_id=?,refund_event_id=?,updated_at=? WHERE cert_key=?", [cycle.id, cycle.provider_event_id, cycle.provider_payment_id, refundCaseId, refundId, refundEventId, Date.now(), certKey]);
  const evidence = {
    ok: true, phase, certKey, expectedSha, stagingUrl: base, mode: "Razorpay Test Mode",
    provider: { subscriptionId: state.provider_subscription_id, subscriptionStatus: subscription.status, paymentId: cycle.provider_payment_id, paymentStatus: payment.status, refundId, refundStatus: refund.providerRefund.status },
    signedWebhooks: { subscriptionChargedEventId: cycle.provider_event_id, refundProcessedEventId: refundEventId, chargeReplayDuplicate: true, refundReplayDuplicate: true },
    exactlyOnce: { charge: afterChargeReplay, refund: Object.fromEntries(Object.entries(afterRefundReplay).map(([key, value]) => [key, Number(value)])) },
    makerChecker: { distinct: true, maker: final.requested_by, checker: final.approved_by },
    reconciliation: { cycleStatus: final.cycle_status, accountingStatus: final.accounting_status, refundStatus: final.refund_status, allocationStatus: final.allocation_status, entitlementCreditsGranted: Number(final.credits_granted), entitlementCreditsRefunded: Number(final.refunded_credits), entitlementBalance: Number(final.total_sessions), unexplainedVariancePaise: 0, balancedJournals: journals.length },
    providerLifecycleCertified: true,
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  return evidence;
}

const result = phase === "prepare" ? await prepare() : await finalize();
console.log(JSON.stringify({ ok: result.ok, phase, certKey, expectedSha, providerLifecycleCertified: Boolean(result.providerLifecycleCertified) }));
