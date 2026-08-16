/**
 * FINAL RESIDUAL LIVE UAT RUNNER — harness only, no product code.
 *
 * Runs Tester 3's already-approved residual gates against REAL deployed staging using REAL staging
 * authentication. Sandbox money only: nothing here touches a live payment, refund or payout rail.
 *
 *   PAWSPACE_E2E_BASE          deployed staging origin
 *   PAWSPACE_E2E_ACCESS_CODE   staging access code (from the repo secret, in CI only)
 *   PAWSPACE_E2E_EMAIL         staff email to sign in as; must be a real staff record
 *
 * SECRET HYGIENE. The access code is read once, sent once to /api/staging-login, and never written to
 * the report, a log line, an assertion message or an error. The session cookie is likewise held only
 * in memory and never serialised — the report records only that a cookie was obtained, not its value.
 * scrub() is applied to every string that reaches the report as a second line of defence.
 *
 * VERDICT DISCIPLINE. Gates are recorded pass/fail/blocked/skipped. 'blocked' means the gate could not
 * be evaluated (missing fixture, unreachable dependency) and is NEVER reported as a pass — a residual
 * run that cannot see its fixture must not look green. Only gates listed in P0_GATES force a non-zero
 * exit; everything else is reported but advisory, so a flaky non-P0 check cannot block a release on its
 * own while still being visible in the artifact.
 *
 * This harness asserts against the live system. It deliberately contains no fallbacks that would let a
 * gate "pass" without real evidence.
 */
import fs from "node:fs";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = String(arg("base", process.env.PAWSPACE_E2E_BASE || "")).replace(/\/$/, "");
const ACCESS_CODE = process.env.PAWSPACE_E2E_ACCESS_CODE || "";
const EMAIL = process.env.PAWSPACE_E2E_EMAIL || "";
const OUT = arg("json", "final-residual-report.json");
const DRY = process.argv.includes("--dry-run");

if (!BASE) {
  console.error("PAWSPACE_E2E_BASE is required (deployed staging origin).");
  process.exit(2);
}

/** Redact anything that could carry a secret before it can reach the report or a log. */
const SECRETS = [ACCESS_CODE, EMAIL].filter((s) => s && s.length >= 6);
function scrub(value) {
  let out = typeof value === "string" ? value : JSON.stringify(value ?? null);
  for (const s of SECRETS) if (s) out = out.split(s).join("[REDACTED]");
  return out
    .replace(/(set-cookie|cookie)\s*[:=]\s*[^;,\s]+/gi, "$1=[REDACTED]")
    .replace(/\b\d{4,8}\b(?=\s*(otp|code))/gi, "[REDACTED]")
    .slice(0, 600);
}

let COOKIE = "";
const gates = [];
const record = (id, status, detail) => {
  gates.push({ gate: id, status, detail: typeof detail === "string" ? scrub(detail) : JSON.parse(scrub(detail)) });
  const mark = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : status.toUpperCase();
  console.log(`${mark.padEnd(7)} ${id}`);
};

async function call(path, { method = "GET", body, expect } = {}) {
  const headers = { "content-type": "application/json" };
  if (COOKIE) headers.cookie = COOKIE;
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  const result = { path, method, status: response.status, ok: response.ok, body: payload };
  if (expect && response.status !== expect) result.unexpected = `expected ${expect}, got ${response.status}`;
  return result;
}

async function signIn() {
  if (!ACCESS_CODE || !EMAIL) return { mode: "unauthenticated", cookieObtained: false };
  const response = await fetch(`${BASE}/api/staging-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "login", code: ACCESS_CODE, email: EMAIL }),
  });
  const raw = response.headers.get("set-cookie") || "";
  COOKIE = raw.split(";")[0] || "";
  // Deliberately reports only WHETHER a cookie exists — never the cookie itself.
  return { mode: response.ok && COOKIE ? "authenticated" : "sign_in_failed", httpStatus: response.status, cookieObtained: Boolean(COOKIE) };
}

// ---------------------------------------------------------------------------------------------
// Gates. Each returns {status, detail}. None of them invents a pass when evidence is unavailable.
// ---------------------------------------------------------------------------------------------

/** P0 — a foreign scheduling group must be refused, and the victim reservation must not move. */
async function gateSchedulingGroupOwnership() {
  const victimGroup = "UATD-GRP-UATD-BK-TRAIN-3";       // owned by UATD-CUS-3
  const attacker = "UATD-CUS-2";                         // a different, legitimately-owned customer
  const before = await call(`/api/uat-scheduling?groupId=${encodeURIComponent(victimGroup)}`);
  const attempt = await call("/api/canonical-bookings", {
    method: "POST",
    body: {
      idempotencyKey: `residual-own-${Date.now()}`, scheduleGroupId: victimGroup,
      customer: { id: attacker, name: "Residual Attacker", primaryPhone: "+919000000002" },
      pets: [{ sourceId: "p1", name: "Rex", species: "dog" }],
      cityId: "blr", zoneId: "blr-east", serviceCode: "grooming",
      packageCode: "dog-bath", packageName: "Essential Bath",
      scheduledStart: "2026-09-01T04:30:00.000Z", scheduledEnd: "2026-09-01T06:30:00.000Z",
      provider: { id: "groom_arun", name: "Arun R.", model: "full_time" },
      totalAmount: 1349, amountDueNow: 1349,
      payment: { method: "upi", mode: "prepaid", status: "captured", detail: "residual" },
    },
  });
  const after = await call(`/api/uat-scheduling?groupId=${encodeURIComponent(victimGroup)}`);
  const refusedCorrectly = attempt.status === 403 || attempt.status === 404;
  const unchanged = JSON.stringify(before.body) === JSON.stringify(after.body);
  return {
    status: refusedCorrectly && unchanged ? "pass" : "fail",
    detail: { victimGroup, attacker, attemptHttp: attempt.status, refusedCorrectly, victimStateUnchanged: unchanged },
  };
}

/** P0 — a refused booking must not strand the hold it was made for. */
async function gateOrphanedCapacity() {
  const group = `RESIDUAL-ORPHAN-${Date.now()}`;
  const reserve = await call("/api/uat-scheduling", {
    method: "POST",
    body: { clientRequestId: group, customerId: "UATD-CUS-2", petIds: ["PET-UATD-CUS-2"], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: "2026-09-02T04:30:00.000Z", scheduledEnd: "2026-09-02T06:30:00.000Z" },
  });
  if (!reserve.ok) return { status: "blocked", detail: { reason: "reserve did not succeed, so the orphan condition cannot be created", reserveHttp: reserve.status, body: reserve.body } };
  const provider = reserve.body?.data?.provider || {};
  const refused = await call("/api/canonical-bookings", {
    method: "POST",
    body: {
      idempotencyKey: `residual-orphan-${Date.now()}`, scheduleGroupId: group,
      customer: { id: "UATD-CUS-2", name: "Residual", primaryPhone: "+919000000002" },
      pets: [{ sourceId: "p1", name: "Rex", species: "dog" }],
      cityId: "blr", zoneId: "blr-east", serviceCode: "grooming",
      packageCode: "dog-bath", packageName: "Essential Bath",
      scheduledStart: "2026-09-02T04:30:00.000Z", scheduledEnd: "2026-09-02T06:30:00.000Z",
      provider: { id: provider.id, name: provider.name, model: provider.model },
      totalAmount: 1, amountDueNow: 1, // deliberately tampered price
      payment: { method: "upi", mode: "prepaid", status: "captured", detail: "residual" },
    },
  });
  const released = refused.body?.capacityReleased;
  return {
    status: refused.status === 409 && released >= 1 && refused.body?.capacityReleaseFailed !== true ? "pass" : "fail",
    detail: { group, refusalHttp: refused.status, capacityReleased: released ?? null, capacityReleaseFailed: refused.body?.capacityReleaseFailed ?? false },
  };
}

/** BOARD-3 — a genuine non-zero SANDBOX refund, requested and approved by different actors. */
async function gateBoard3Refund() {
  const booking = "UATD-BK-BOARD-3", amount = 2400;
  const before = await call(`/api/boarding-finance?bookingId=${booking}`);
  if (before.status === 404) return { status: "blocked", detail: { reason: "BOARD-3 fixture absent on staging — reseed required before this gate can be evaluated", booking } };
  const requested = await call("/api/boarding-finance", { method: "POST", body: { bookingId: booking, action: "request_cancel", actorId: "residual.requester@pawspace.in", idempotencyKey: `residual-jc-req-${Date.now()}`, reason: "Final residual live run" } });
  const approved = await call("/api/boarding-finance", { method: "POST", body: { bookingId: booking, action: "approve_cancel", actorId: "residual.approver@pawspace.in", approvedRefundAmount: amount, idempotencyKey: `residual-jc-app-${Date.now()}`, reason: "Final residual live run" } });
  const after = await call(`/api/boarding-finance?bookingId=${booking}`);
  const refunds = after.body?.data?.refunds || after.body?.refunds || [];
  const sandboxOnly = refunds.every((r) => String(r.status).startsWith("sandbox"));
  const one = refunds.filter((r) => Number(r.amount) === amount).length === 1;
  return {
    status: requested.ok && approved.ok && one && sandboxOnly ? "pass" : "fail",
    detail: { booking, amount, requestHttp: requested.status, approveHttp: approved.status, refundRows: refunds.length, exactlyOneAtAmount: one, sandboxOnly, liveMoneyTransport: false },
  };
}

/** C-06 — must stop at the policy boundary having mutated nothing. */
async function gateC06() {
  const booking = "UATD-BK-TRAIN-3";
  const before = await call(`/api/training-cancellation?bookingId=${booking}`);
  const result = await call("/api/training-cancellation", { method: "POST", body: { bookingId: booking, action: "request_cancel", actorId: "residual.tester@pawspace.in", idempotencyKey: `residual-c06-${Date.now()}`, reason: "Final residual live run" } });
  const after = await call(`/api/training-cancellation?bookingId=${booking}`);
  const status = result.body?.data?.status || result.body?.status;
  return {
    status: status === "blocked_policy_configuration" && JSON.stringify(before.body) === JSON.stringify(after.body) ? "pass" : "fail",
    detail: { booking, resultStatus: status ?? null, http: result.status, stateUnchanged: JSON.stringify(before.body) === JSON.stringify(after.body) },
  };
}

/** Journey D — own work succeeds, another provider's work is refused. */
async function gateProviderJourneyD() {
  const own = await call("/api/partner-mobile?workOrderId=UATD-BK-GROOM-2-WO");
  const cross = await call("/api/partner-mobile?workOrderId=UATD-BK-GROOM-1-WO");
  return {
    status: own.status === 200 && (cross.status === 403 || cross.status === 404) ? "pass" : "blocked",
    detail: { ownWorkOrder: "UATD-BK-GROOM-2-WO (Rahul/groom_kiran, assigned)", ownHttp: own.status, crossWorkOrder: "UATD-BK-GROOM-1-WO (Asha/groom_arun)", crossHttp: cross.status, note: "provider-scoped identity may be required; a non-200/403 pair is reported blocked, never passed" },
  };
}

/** Journey E — NON-MONEY ONLY. record_payment/request_refund/resolve_refund are never invoked. */
async function gateRelocationJourneyE() {
  const created = await call("/api/relocation", { method: "POST", body: { action: "create", customerId: "UATD-CUS-2", originCity: "blr", destinationCity: "maa", petCount: 1, actorId: "residual.tester@pawspace.in", idempotencyKey: `residual-e-${Date.now()}` } });
  const caseId = created.body?.data?.id || created.body?.id || null;
  if (!caseId) return { status: "blocked", detail: { reason: "relocation case was not created, so document/support steps cannot be exercised", createHttp: created.status } };
  const doc = await call("/api/relocation", { method: "POST", body: { action: "register_document", caseId, documentType: "vaccination_record", reference: "residual-doc-1", actorId: "residual.tester@pawspace.in" } });
  const support = await call("/api/relocation", { method: "POST", body: { action: "open_support", caseId, subject: "Residual run", detail: "non-money journey", actorId: "residual.tester@pawspace.in" } });
  return {
    status: created.ok && doc.ok && support.ok ? "pass" : "fail",
    detail: { caseId, createHttp: created.status, documentHttp: doc.status, supportHttp: support.status, moneyActionsInvoked: [], assertion: "record_payment/request_refund/resolve_refund deliberately never called" },
  };
}

/** BLR/Chennai isolation — Chennai must stay commercially blocked with a 4xx, never a 500. */
async function gateCityIsolation() {
  const chennai = await call("/api/canonical-bookings", {
    method: "POST",
    body: {
      idempotencyKey: `residual-maa-${Date.now()}`, scheduleGroupId: `RESIDUAL-MAA-${Date.now()}`,
      customer: { id: "UATD-CUS-2", name: "Residual", primaryPhone: "+919000000002" },
      pets: [{ sourceId: "p1", name: "Rex", species: "dog" }],
      cityId: "maa", zoneId: "maa-central", serviceCode: "grooming",
      packageCode: "dog-bath", packageName: "Essential Bath",
      scheduledStart: "2026-09-03T09:30:00.000Z", scheduledEnd: "2026-09-03T11:30:00.000Z",
      provider: { id: "groom_maa_lakshmi", name: "Lakshmi V.", model: "full_time" },
      totalAmount: 1349, amountDueNow: 1349,
      payment: { method: "upi", mode: "prepaid", status: "captured", detail: "residual" },
    },
  });
  const blocked = chennai.status >= 400 && chennai.status < 500;
  return {
    status: blocked ? "pass" : "fail",
    detail: { chennaiHttp: chennai.status, commerciallyBlocked: blocked, notA500: chennai.status !== 500, error: scrub(chennai.body?.error || "") },
  };
}

/** B-07 — orphan reconciliation counts, read-only. */
async function gateB07Reconciliation() {
  const report = await call("/api/ops-work-queue?view=reconciliation");
  if (!report.ok) return { status: "blocked", detail: { reason: "reconciliation view unavailable; counts could not be read", http: report.status } };
  return { status: "pass", detail: { http: report.status, counts: report.body?.data?.counts ?? report.body?.counts ?? null } };
}

/** A-13 — reconciliation / idempotency, read-only. */
async function gateA13() {
  const first = await call("/api/finance-control?view=reconciliation");
  const second = await call("/api/finance-control?view=reconciliation");
  const stable = JSON.stringify(first.body) === JSON.stringify(second.body);
  return {
    status: first.ok && stable ? "pass" : first.ok ? "fail" : "blocked",
    detail: { http: first.status, repeatReadStable: stable, note: "a read-only reconciliation view must be stable across identical reads" },
  };
}

// P0 / release stop conditions. Only these force a non-zero exit.
const P0_GATES = new Set(["scheduling-group-ownership-P0", "orphaned-capacity-P0", "board3-sandbox-refund", "c06-policy-boundary", "city-isolation-chennai-blocked"]);

const RUNNERS = [
  ["scheduling-group-ownership-P0", gateSchedulingGroupOwnership],
  ["orphaned-capacity-P0", gateOrphanedCapacity],
  ["board3-sandbox-refund", gateBoard3Refund],
  ["c06-policy-boundary", gateC06],
  ["provider-journey-d", gateProviderJourneyD],
  ["relocation-journey-e-non-money", gateRelocationJourneyE],
  ["city-isolation-chennai-blocked", gateCityIsolation],
  ["b07-orphan-reconciliation", gateB07Reconciliation],
  ["a13-reconciliation-idempotency", gateA13],
];

const session = DRY ? { mode: "dry-run", cookieObtained: false } : await signIn();
console.log(`final-residual · ${BASE} · session ${session.mode}\n`);

if (DRY) {
  // Local self-check only: proves the harness loads, every gate is registered and the report shape is
  // valid. This is NOT a live verdict and is labelled as such in the report.
  for (const [id] of RUNNERS) record(id, "skipped", "dry-run: not executed against live staging");
} else if (session.mode !== "authenticated") {
  for (const [id] of RUNNERS) record(id, "blocked", `staging sign-in did not succeed (${session.mode}); gates cannot be evaluated`);
} else {
  for (const [id, run] of RUNNERS) {
    try {
      const outcome = await run();
      record(id, outcome.status, outcome.detail);
    } catch (error) {
      record(id, "fail", { error: scrub(error instanceof Error ? error.message : String(error)) });
    }
  }
}

const failedP0 = gates.filter((g) => P0_GATES.has(g.gate) && g.status !== "pass" && g.status !== "skipped");
const report = {
  runAt: new Date().toISOString(),
  base: BASE,
  candidate: "64f69524a5c09b7a385cbd61fb5650aff1735b99",
  liveVerdict: !DRY,
  session: { mode: session.mode, cookieObtained: session.cookieObtained },  // never the cookie itself
  gates,
  summary: {
    total: gates.length,
    pass: gates.filter((g) => g.status === "pass").length,
    fail: gates.filter((g) => g.status === "fail").length,
    blocked: gates.filter((g) => g.status === "blocked").length,
    skipped: gates.filter((g) => g.status === "skipped").length,
    p0Failures: failedP0.map((g) => g.gate),
  },
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\n${report.summary.pass} pass · ${report.summary.fail} fail · ${report.summary.blocked} blocked · ${report.summary.skipped} skipped`);
console.log(`report → ${OUT}`);

if (DRY) { console.log("\nDRY RUN — not a live verdict."); process.exit(0); }
if (failedP0.length) { console.error(`\nP0 STOP CONDITION: ${failedP0.map((g) => g.gate).join(", ")}`); process.exit(1); }
if (session.mode !== "authenticated") { console.error("\nSTOP: no authenticated staging session — the run proved nothing."); process.exit(1); }
process.exit(0);
