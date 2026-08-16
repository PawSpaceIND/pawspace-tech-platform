/**
 * TARGETED CLOSURE RUNNER — four gates only.
 *
 * The full residual suite has already produced its evidence. Re-running it against fixed UAT fixtures
 * cannot produce new information: those fixtures are single-use, so a second run either replays an
 * already-terminal state or destroys state to re-prove arithmetic. This runner therefore executes ONLY
 * the four gates that still lack valid live evidence, and it manufactures FRESH unique runtime state
 * for the two that mutate, so nothing depends on a fixture another run already consumed.
 *
 * Deliberately NOT here: BOARD-3 cancellation/refund (already proven, and single-use — re-running it
 * would need a second funded fixture), and the scheduling / orphan-capacity / C-06 / fixed
 * provider-work-order gates (already evidenced against fixtures that are now spent).
 *
 * Secret hygiene identical to the residual runner: the access code is sent once to /api/staging-login
 * and never logged or serialised; cookies live in memory only; scrub() redacts defensively.
 */
import fs from "node:fs";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = String(arg("base", process.env.PAWSPACE_E2E_BASE || "")).replace(/\/$/, "");
const ACCESS_CODE = process.env.PAWSPACE_E2E_ACCESS_CODE || "";
const OUT = arg("json", "targeted-closure-report.json");
const DRY = process.argv.includes("--dry-run");

if (!BASE) { console.error("PAWSPACE_E2E_BASE is required."); process.exit(2); }

const PERSONAS = {
  manager: process.env.PAWSPACE_E2E_MANAGER || "sunita.manager37@tkpetcare.in",
  finance: process.env.PAWSPACE_E2E_FINANCE || "anjali.finance33@tkpetcare.in",
  rahul: process.env.PAWSPACE_E2E_PROVIDER_RAHUL || "rahul.groomer2@tkpetcare.in",
  asha: process.env.PAWSPACE_E2E_PROVIDER_ASHA || "asha.groomer1@tkpetcare.in",
};
const SECRETS = [ACCESS_CODE].filter((s) => s && s.length >= 6);
function scrub(value) {
  let out = typeof value === "string" ? value : JSON.stringify(value ?? null);
  for (const s of SECRETS) out = out.split(s).join("[REDACTED]");
  return out.replace(/(set-cookie|cookie)\s*[:=]\s*[^;,\s]+/gi, "$1=[REDACTED]").slice(0, 600);
}

const JAR = new Map();
const gates = [];
const record = (id, status, detail) => {
  gates.push({ gate: id, status, detail: JSON.parse(scrub(detail)) });
  console.log(`${(status === "pass" ? "PASS" : status.toUpperCase()).padEnd(7)} ${id}`);
};

async function signIn(persona) {
  const email = PERSONAS[persona];
  if (!ACCESS_CODE || !email) return { persona, mode: "unconfigured", cookieObtained: false };
  const r = await fetch(`${BASE}/api/staging-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "login", code: ACCESS_CODE, email }) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0] || "";
  if (cookie) JAR.set(persona, cookie);
  return { persona, email, mode: r.ok && cookie ? "authenticated" : "sign_in_failed", httpStatus: r.status, cookieObtained: Boolean(cookie) };
}

async function call(persona, path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  const cookie = JAR.get(persona);
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  let payload = null;
  try { payload = await r.json(); } catch { payload = null; }
  return { persona, path, method, status: r.status, ok: r.ok, body: payload };
}
const authGap = (p) => !JAR.get(p);

/**
 * JOURNEY D — fresh unique runtime state, then a GENUINE unauthorized mutation.
 *
 * A new grooming booking is reserved onto groom_kiran and confirmed, producing a brand-new work order
 * that no previous run has touched and that is still active. Asha (groom_arun) then attempts the real
 * progression mutation on it FIRST — while it is genuinely still progressable, so a 403 cannot be
 * explained away by the job already being complete. Only afterwards does Rahul perform his own
 * allowed progression.
 */
async function gateJourneyD() {
  if (authGap("manager") || authGap("rahul")) return { status: "blocked", detail: { reason: "manager and/or rahul session unavailable — RUNNER auth gap, not a product refusal" } };
  const stamp = Date.now();
  const group = `CLOSURE-JD-${stamp}`;
  const start = "2026-09-20T04:30:00.000Z", end = "2026-09-20T06:30:00.000Z";

  const reserve = await call("manager", "/api/uat-scheduling", {
    method: "POST",
    body: { clientRequestId: group, customerId: "UATD-CUS-2", petIds: ["PET-UATD-CUS-2"], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: start, scheduledEnd: end, preferredProviderId: "groom_kiran" },
  });
  if (!reserve.ok) return { status: "blocked", detail: { reason: "could not reserve fresh state onto groom_kiran", http: reserve.status, error: scrub(reserve.body?.error || "") } };
  const provider = reserve.body?.data?.provider || {};
  if (provider.id !== "groom_kiran") return { status: "blocked", detail: { reason: "matching did not select groom_kiran; Rahul would not own the work order", selected: provider.id ?? null } };

  const bookingId = `CLOSURE-BK-${stamp}`;
  const confirm = await call("manager", "/api/canonical-bookings", {
    method: "POST",
    body: {
      idempotencyKey: `closure-jd-${stamp}`, scheduleGroupId: group,
      customer: { id: "UATD-CUS-2", name: "Closure", primaryPhone: "+919000000002" },
      pets: [{ sourceId: "p1", name: "Rex", species: "dog" }],
      cityId: "blr", zoneId: "blr-east", serviceCode: "grooming",
      packageCode: "dog-bath", packageName: "Essential Bath",
      scheduledStart: start, scheduledEnd: end,
      provider: { id: "groom_kiran", name: provider.name, model: provider.model },
      totalAmount: 1349, amountDueNow: 1349,
      payment: { method: "upi", mode: "prepaid", status: "captured", detail: "closure" },
    },
  });
  if (!confirm.ok) return { status: "blocked", detail: { reason: "could not confirm the fresh booking; no active work order exists to test", http: confirm.status, error: scrub(confirm.body?.error || "") } };
  const realBookingId = confirm.body?.data?.bookingId ?? confirm.body?.data?.id ?? bookingId;

  const before = await call("rahul", `/api/grooming-lifecycle?bookingId=${encodeURIComponent(realBookingId)}`);
  if (!before.ok) return { status: "blocked", detail: { reason: "could not read the fresh work order before mutating", http: before.status, bookingId: realBookingId } };

  // THE UNAUTHORIZED MUTATION — genuine, against still-active state.
  const cross = authGap("asha") ? null : await call("asha", "/api/grooming-lifecycle", { method: "POST", body: { action: "complete", bookingId: realBookingId, actorId: PERSONAS.asha, idempotencyKey: `closure-jd-cross-${stamp}` } });
  const afterCross = await call("rahul", `/api/grooming-lifecycle?bookingId=${encodeURIComponent(realBookingId)}`);
  const victimUnchanged = JSON.stringify(before.body) === JSON.stringify(afterCross.body);
  const crossRefused = cross === null ? null : cross.status === 403;

  // SECURITY STOP: unauthorized mutation both succeeded AND changed state.
  const securityDefect = cross !== null && cross.ok && !victimUnchanged;

  const own = await call("rahul", "/api/grooming-lifecycle", { method: "POST", body: { action: "complete", bookingId: realBookingId, actorId: PERSONAS.rahul, idempotencyKey: `closure-jd-own-${stamp}` } });
  const after = await call("rahul", `/api/grooming-lifecycle?bookingId=${encodeURIComponent(realBookingId)}`);
  const advanced = JSON.stringify(afterCross.body) !== JSON.stringify(after.body);

  return {
    status: securityDefect ? "product_security_defect" : (own.status === 200 && crossRefused === true && victimUnchanged && advanced ? "pass" : "fail"),
    detail: {
      freshState: true, bookingId: realBookingId, group, provider: "groom_kiran",
      endpoint: "/api/grooming-lifecycle", action: "complete",
      crossProviderMutationHttp: cross?.status ?? "skipped (no asha session)",
      crossRefused403: crossRefused, victimByteIdenticalAfterUnauthorizedAttempt: victimUnchanged,
      ownProgressionHttp: own.status, ownStateAdvanced: advanced,
      productSecurityDefect: securityDefect,
    },
  };
}

/** B-07 — read-only canonical payment reconciliation. No mutation of any kind. */
async function gateB07() {
  if (authGap("finance")) return { status: "blocked", detail: { reason: "finance session unavailable — RUNNER auth gap" } };
  const report = await call("finance", "/api/payment-reconciliation");
  if (!report.ok) return { status: "blocked", detail: { persona: "finance", reason: "reconciliation view unavailable", http: report.status } };
  const exceptions = report.body?.data?.exceptions;
  if (!Array.isArray(exceptions)) return { status: "blocked", detail: { persona: "finance", reason: "data.exceptions absent or not an array — contract unmet, nothing asserted", keys: Object.keys(report.body?.data ?? {}) } };
  const wellFormed = exceptions.every((e) => e && typeof e === "object" && "id" in e && "booking_id" in e);
  return {
    status: wellFormed ? "pass" : "fail",
    detail: { persona: "finance", endpoint: "/api/payment-reconciliation", http: report.status, readOnly: true, mutations: 0, exceptionCount: exceptions.length, allRowsCarryCanonicalLinkage: wellFormed, sampleBookingIds: exceptions.slice(0, 3).map((e) => e.booking_id ?? null) },
  };
}

/** JOURNEY E — fresh unique case; money invariants asserted from canonical fields throughout. */
async function gateJourneyE() {
  if (authGap("manager")) return { status: "blocked", detail: { reason: "manager session unavailable — RUNNER auth gap" } };
  const created = await call("manager", "/api/relocation", {
    method: "POST",
    body: { action: "create", customerId: "UATD-CUS-2", petName: "Rex", breed: "Indie", ageYears: 3, sizeClass: "medium", travelMode: "air", originCountry: "India", originCity: "blr", destinationCountry: "India", destinationCity: "maa", targetTravelDate: "2026-10-15", crateRequirement: "assessment_required" },
  });
  const caseId = created.body?.data?.id ?? created.body?.data?.caseId ?? created.body?.id ?? null;
  if (!created.ok || !caseId) return { status: "blocked", detail: { reason: "relocation case not created", http: created.status, error: scrub(created.body?.error || "") } };

  const read = async () => {
    const r = await call("manager", `/api/relocation?caseId=${encodeURIComponent(caseId)}`);
    return r.ok && r.body?.data ? r.body.data : null;
  };
  const check = (d) => d === null ? null : ({
    quote: d.quote === undefined ? "blocked: data.quote not exposed" : d.quote === null,
    vendor: d.vendor_id === undefined ? "blocked: data.vendor_id not exposed" : (d.vendor_id ?? null) === null,
    payment: d.payment === undefined ? "blocked: data.payment not exposed" : d.payment === null,
    refunds: !Array.isArray(d.refunds) ? "blocked: data.refunds not exposed" : d.refunds.length === 0,
  });

  const afterCreate = await read();
  if (!afterCreate) return { status: "blocked", detail: { reason: "canonical case read unavailable after create", caseId } };
  const doc = await call("manager", "/api/relocation", { method: "POST", body: { action: "register_document", caseId, documentType: "vaccination_record", objectId: `closure-doc-${Date.now()}`, note: "targeted closure" } });
  const afterDoc = await read();
  const support = await call("manager", "/api/relocation", { method: "POST", body: { action: "open_support", caseId, note: "Targeted closure non-money journey", reason: "closure" } });
  const afterSupport = await read();

  // "throughout" - the invariants are checked at every step, not only at the end.
  const stages = { afterCreate: check(afterCreate), afterDocument: check(afterDoc), afterSupport: check(afterSupport) };
  const allChecks = Object.values(stages).filter(Boolean).flatMap((s) => Object.values(s));
  const blockedEvidence = allChecks.filter((v) => typeof v === "string");
  const held = allChecks.every((v) => v === true);
  const docRegistered = Array.isArray(afterSupport?.documents) && afterSupport.documents.length > (Array.isArray(afterCreate.documents) ? afterCreate.documents.length : 0);

  return {
    status: blockedEvidence.length ? "blocked" : (doc.ok && support.ok && docRegistered && held ? "pass" : "fail"),
    detail: {
      freshState: true, caseId, createHttp: created.status, documentHttp: doc.status, supportHttp: support.status,
      invariantsByStage: stages, documentActuallyRegistered: docRegistered,
      blockedEvidence: [...new Set(blockedEvidence)], moneyActionsInvoked: [],
      assertion: "quote/vendor/payment/refund asserted null-or-empty at every stage",
    },
  };
}

/**
 * A-13 — read-only, arithmetic only. No destructive state is created to prove this.
 *
 * The previous evaluator compared the two responses byte-for-byte, so any timestamp or ordering
 * difference failed the gate even when the reconciliation itself was perfectly balanced
 * (programmes=1, reconciled=1, exceptions=0 is balanced: 1 + 0 <= 1). It now compares the
 * reconciliation FIGURES across the two reads, which is what "no duplicate capture" actually means.
 */
async function gateA13() {
  if (authGap("manager")) return { status: "blocked", detail: { reason: "manager session unavailable — RUNNER auth gap" } };
  const first = await call("manager", "/api/training-reconciliation");
  if (!first.ok) return { status: "blocked", detail: { persona: "manager", reason: "training reconciliation unavailable", http: first.status } };
  const s1 = first.body?.data?.summary;
  if (!s1 || typeof s1.programmes !== "number") return { status: "blocked", detail: { persona: "manager", reason: "data.summary.programmes absent — contract unmet, nothing asserted", keys: Object.keys(first.body?.data ?? {}) } };
  const second = await call("manager", "/api/training-reconciliation");
  const s2 = second.body?.data?.summary ?? {};

  const balanced = s1.reconciled + s1.exceptions <= s1.programmes;
  const figuresStable = s2.programmes === s1.programmes && s2.reconciled === s1.reconciled && s2.exceptions === s1.exceptions;
  return {
    status: balanced && figuresStable ? "pass" : "fail",
    detail: { persona: "manager", endpoint: "/api/training-reconciliation", http: first.status, readOnly: true, mutations: 0, summary: s1, reconciliationBalanced: balanced, figuresStableAcrossReads: figuresStable, note: "figures compared, not whole-body bytes — a timestamp must not fail balanced arithmetic" },
  };
}

const RUNNERS = [["journey-d-cross-provider", gateJourneyD], ["b07-payment-reconciliation", gateB07], ["journey-e-non-money", gateJourneyE], ["a13-reconciliation", gateA13]];
const REQUIRED_PERSONAS = ["manager", "finance", "rahul", "asha"];

const sessions = [];
if (!DRY) for (const p of REQUIRED_PERSONAS) sessions.push(await signIn(p));
const authed = sessions.filter((s) => s.mode === "authenticated").map((s) => s.persona);
console.log(`targeted-closure · ${BASE} · personas: ${authed.join(", ") || "none"}\n`);

if (DRY) { for (const [id] of RUNNERS) record(id, "skipped", { reason: "dry-run" }); }
else if (!authed.length) { for (const [id] of RUNNERS) record(id, "blocked", { reason: "no persona could sign in — RUNNER/credential problem, not a product failure" }); }
else for (const [id, run] of RUNNERS) {
  try { const o = await run(); record(id, o.status, o.detail); }
  catch (e) { record(id, "fail", { error: scrub(e instanceof Error ? e.message : String(e)) }); }
}

const securityDefects = gates.filter((g) => g.status === "product_security_defect").map((g) => g.gate);
const failures = gates.filter((g) => g.status === "fail").map((g) => g.gate);
const blocked = gates.filter((g) => g.status === "blocked").map((g) => g.gate);
const allPassed = gates.length > 0 && gates.every((g) => g.status === "pass");

const report = {
  runAt: new Date().toISOString(), base: BASE,
  targetDeployedCandidateSha: process.env.PAWSPACE_CANDIDATE_SHA || "64f69524a5c09b7a385cbd61fb5650aff1735b99",
  runnerHarnessSha: process.env.GITHUB_SHA || "(local)",
  scope: "targeted closure — Journey D, B-07, Journey E, A-13 only; BOARD-3 and spent fixtures deliberately excluded",
  liveVerdict: !DRY && allPassed,
  personas: sessions.map((s) => ({ persona: s.persona, email: s.email ?? null, mode: s.mode, cookieObtained: s.cookieObtained })),
  gates,
  summary: { total: gates.length, pass: gates.filter((g) => g.status === "pass").length, fail: failures.length, blocked: blocked.length, productSecurityDefects: securityDefects, failures, blockedGates: blocked },
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\n${report.summary.pass} pass · ${report.summary.fail} fail · ${report.summary.blocked} blocked`);
console.log(`liveVerdict=${report.liveVerdict} · report → ${OUT}`);

if (DRY) { console.log("\nDRY RUN — not a live verdict."); process.exit(0); }
if (securityDefects.length) { console.error(`\nPRODUCT SECURITY DEFECT — unauthorized mutation succeeded AND changed state: ${securityDefects.join(", ")}`); process.exit(3); }
if (failures.length) { console.error(`\nFAILURE (release stop): ${failures.join(", ")}`); process.exit(1); }
if (blocked.length) { console.error(`\nSETUP/EVIDENCE BLOCKER (release stop, NOT a product defect): ${blocked.join(", ")}`); process.exit(1); }
process.exit(0);
