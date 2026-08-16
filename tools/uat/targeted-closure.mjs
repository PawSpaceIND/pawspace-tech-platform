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
  associate: process.env.PAWSPACE_E2E_ASSOCIATE || "anita.associate17@tkpetcare.in",
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
 * Derive a customer that GENUINELY owns a canonical pet, instead of assuming an id shape.
 *
 * Run #1 blocked Journey D on a 403 "A pet in this request does not belong to this customer": the
 * gate assumed the pet id was `PET-UATD-CUS-2`, but the seeded pet is `UATD-CUS-2-PET`, and
 * /api/uat-scheduling checks pet ownership against canonical_pets before it will reserve. An id
 * invented by the harness can never satisfy that check, so the gate could only ever block.
 *
 * customer-360 is the read model over canonical_customers + canonical_pets, so the pair it returns is
 * the same relationship the reserve validates against. Preferred ids are still tried first, but they
 * are VERIFIED to have a pet rather than trusted; if none does, any customer with a real pet is used.
 * The customer's own name and phone come back with it, so the confirm step can echo them instead of
 * overwriting a seeded customer's identity (canonical-bookings upserts those columns).
 */
async function resolveCustomerWithPet(persona, preferred = []) {
  const attempts = [];
  const pick = (records) => (Array.isArray(records) ? records : []).find((r) => Array.isArray(r?.pets) && r.pets.length > 0);
  const shape = (record, derivedFrom) => ({
    customerId: String(record.customerId), pet: record.pets[0],
    name: record.name ?? null, primaryPhone: record.primaryPhone ?? null, derivedFrom, attempts,
  });

  for (const customerId of preferred) {
    const r = await call(persona, `/api/customer-360?customerId=${encodeURIComponent(customerId)}`);
    const records = r.ok ? r.body?.data?.records : null;
    const record = pick(records);
    attempts.push({ scope: customerId, http: r.status, records: Array.isArray(records) ? records.length : null, hasPet: Boolean(record) });
    if (record) return shape(record, `customer-360?customerId=${customerId}`);
  }

  const all = await call(persona, "/api/customer-360");
  const records = all.ok ? all.body?.data?.records : null;
  const record = pick(records);
  attempts.push({ scope: "all", http: all.status, records: Array.isArray(records) ? records.length : null, hasPet: Boolean(record) });
  if (record) return shape(record, "customer-360 (scan for any customer owning a canonical pet)");

  return { customerId: null, pet: null, name: null, primaryPhone: null, derivedFrom: null, attempts };
}

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

  const subject = await resolveCustomerWithPet("manager", ["UATD-CUS-2", "UATD-CUS-1"]);
  if (!subject.customerId || !subject.pet?.id) {
    return { status: "blocked", detail: { reason: "no customer owning a canonical pet could be derived — a valid reserve cannot be built", derivationAttempts: subject.attempts } };
  }

  const reserve = await call("manager", "/api/uat-scheduling", {
    method: "POST",
    body: { clientRequestId: group, customerId: subject.customerId, petIds: [subject.pet.id], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: start, scheduledEnd: end, preferredProviderId: "groom_kiran" },
  });
  if (!reserve.ok) return { status: "blocked", detail: { reason: "could not reserve fresh state onto groom_kiran", http: reserve.status, group, error: scrub(reserve.body?.error || JSON.stringify(reserve.body)) } };
  const provider = reserve.body?.data?.provider || {};
  if (provider.id !== "groom_kiran") return { status: "blocked", detail: { reason: "matching did not select groom_kiran; Rahul would not own the work order", selected: provider.id ?? null } };

  // canonical-bookings upserts canonical_customers with ON CONFLICT DO UPDATE over name and
  // primary_phone, so a placeholder identity here would RENAME the seeded customer as a side effect of
  // the gate. The derived name and phone are written straight back, making that upsert a no-op on
  // identity. Refuse to proceed rather than overwrite a real record with a placeholder.
  if (!subject.name || !subject.primaryPhone) {
    return { status: "blocked", detail: { reason: "derived customer exposed no name/phone; confirming would overwrite the seeded customer identity", customerId: subject.customerId, derivedFrom: subject.derivedFrom } };
  }
  const bookingId = `CLOSURE-BK-${stamp}`;
  const confirm = await call("manager", "/api/canonical-bookings", {
    method: "POST",
    body: {
      idempotencyKey: `closure-jd-${stamp}`, scheduleGroupId: group,
      customer: { id: subject.customerId, name: subject.name, primaryPhone: subject.primaryPhone },
      pets: [{ sourceId: "p1", name: subject.pet.name, species: subject.pet.species || "dog" }],
      cityId: "blr", zoneId: "blr-east", serviceCode: "grooming",
      packageCode: "dog-bath", packageName: "Essential Bath",
      scheduledStart: start, scheduledEnd: end,
      provider: { id: "groom_kiran", name: provider.name, model: provider.model },
      totalAmount: 1349, amountDueNow: 1349,
      payment: { method: "upi", mode: "prepaid", status: "captured", detail: "closure" },
    },
  });
  if (!confirm.ok) return { status: "blocked", detail: { reason: "could not confirm the fresh booking; no active work order exists to test", http: confirm.status, group, error: scrub(confirm.body?.error || JSON.stringify(confirm.body)) } };
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
      customerId: subject.customerId, petId: subject.pet.id, subjectDerivedFrom: subject.derivedFrom,
      endpoint: "/api/grooming-lifecycle", action: "complete",
      crossProviderMutationHttp: cross?.status ?? "skipped (no asha session)",
      crossRefused403: crossRefused, victimByteIdenticalAfterUnauthorizedAttempt: victimUnchanged,
      ownProgressionHttp: own.status, ownStateAdvanced: advanced,
      productSecurityDefect: securityDefect,
    },
  };
}

/**
 * B-07 — reads the evidence produced by the preceding read-only D1 step.
 * /api/payment-reconciliation exists in the frozen source but 404s on the deployed build, so calling
 * it again would only re-prove that. tools/uat/b07-reconciliation-evidence.mjs queries the canonical
 * tables directly (SELECT only) and this gate consumes its verdict.
 */
async function gateB07() {
  let evidence = null;
  try { evidence = JSON.parse(fs.readFileSync("b07-reconciliation-evidence.json", "utf8")); }
  catch { return { status: "blocked", detail: { reason: "b07-reconciliation-evidence.json absent — the read-only D1 evidence step did not run", source: "direct D1" } }; }
  return {
    status: evidence.verdict === "pass" ? "pass" : evidence.verdict === "fail" ? "fail" : "blocked",
    detail: { source: evidence.source, readOnly: evidence.readOnly, mutations: evidence.mutations, counts: evidence.counts, contractSatisfied: evidence.contractSatisfied, subsetsConsistent: evidence.subsetsConsistent, d1ReadError: evidence.d1ReadError ?? null },
  };
}

/** JOURNEY E — fresh unique case; money invariants asserted from canonical fields throughout. */
async function gateJourneyE() {
  if (authGap("manager")) return { status: "blocked", detail: { reason: "manager session unavailable — RUNNER auth gap" } };
  // Run #1352 blocked here with "relocation case not created". The seed shows UATD-CUS-2 is a real
  // active Bengaluru customer, so the refusal is an actor-side ownership/scope condition rather than a
  // missing customer. Rather than guess at the rule, try the manager first and fall back to the
  // associate (which holds scheduling.book WITHOUT the customers.manage bypass), and report the exact
  // refusal from each so the next run diagnoses itself instead of blocking again.
  const createBody = { action: "create", customerId: "UATD-CUS-2", petName: "Rex", breed: "Indie", ageYears: 3, sizeClass: "medium", travelMode: "air", originCountry: "India", originCity: "blr", destinationCountry: "India", destinationCity: "maa", targetTravelDate: "2026-10-15", crateRequirement: "assessment_required" };
  const attempts = [];
  let created = null, actor = null;
  for (const persona of ["manager", "associate"]) {
    if (authGap(persona)) { attempts.push({ persona, skipped: "no session" }); continue; }
    const r = await call(persona, "/api/relocation", { method: "POST", body: createBody });
    attempts.push({ persona, http: r.status, error: scrub(r.body?.error || "") });
    if (r.ok) { created = r; actor = persona; break; }
  }
  const caseId = created?.body?.data?.id ?? created?.body?.data?.caseId ?? created?.body?.id ?? null;
  if (!created || !caseId) return { status: "blocked", detail: { reason: "relocation case not created by any eligible persona", customerId: "UATD-CUS-2", attempts } };

  const read = async () => {
    const r = await call(actor, `/api/relocation?caseId=${encodeURIComponent(caseId)}`);
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
  // The checklist is SEEDED at case creation: createRelocationCase inserts one relocation_documents
  // row per required type at status 'required', and relocation_documents is UNIQUE(case_id,
  // document_type). register_document is therefore an UPDATE of an existing row — object_id set,
  // status 'required' -> 'uploaded' — and the array length is CONSTANT by design.
  //
  // Run #1 failed here asserting the array had GROWN, which this schema can never do. That was the
  // harness reading the wrong field, not the product dropping the document: verified by real
  // execution against lib/relocation-governance.ts on a real SQLite database — the row transitioned to
  // 'uploaded' with the exact object_id, and a document_uploaded event was written.
  //
  // The assertion below is the correct one and is STRICTER than a length check: it pins the specific
  // document's state transition AND the exact object id round-tripping, at every later read.
  const DOC_TYPE = "vaccination_record";
  const DOC_OBJECT_ID = `closure-doc-${Date.now()}`;
  const findDoc = (snapshot) => !Array.isArray(snapshot?.documents) ? undefined : snapshot.documents.find((d) => d?.document_type === DOC_TYPE);
  const docBefore = findDoc(afterCreate);

  const doc = await call(actor, "/api/relocation", { method: "POST", body: { action: "register_document", caseId, documentType: DOC_TYPE, objectId: DOC_OBJECT_ID, note: "targeted closure" } });
  const afterDoc = await read();
  const support = await call(actor, "/api/relocation", { method: "POST", body: { action: "open_support", caseId, note: "Targeted closure non-money journey", reason: "closure" } });
  const afterSupport = await read();

  // "throughout" - the invariants are checked at every step, not only at the end.
  const stages = { afterCreate: check(afterCreate), afterDocument: check(afterDoc), afterSupport: check(afterSupport) };
  const allChecks = Object.values(stages).filter(Boolean).flatMap((s) => Object.values(s));
  const blockedEvidence = allChecks.filter((v) => typeof v === "string");
  const held = allChecks.every((v) => v === true);
  const docAfter = findDoc(afterDoc), docPersisted = findDoc(afterSupport);
  // Not exposing the checklist at all is missing evidence, not a product failure — same treatment as
  // the money invariants above, so it reports as blocked rather than as a false FAIL.
  const docEvidenceMissing = [afterCreate, afterDoc, afterSupport].some((s) => !Array.isArray(s?.documents))
    ? "blocked: data.documents not exposed"
    : (docBefore === undefined ? `blocked: no ${DOC_TYPE} row seeded on the case` : null);
  if (docEvidenceMissing) blockedEvidence.push(docEvidenceMissing);

  const docRegistered = !docEvidenceMissing
    && docAfter?.status === "uploaded" && docAfter?.object_id === DOC_OBJECT_ID
    && docPersisted?.status === "uploaded" && docPersisted?.object_id === DOC_OBJECT_ID;

  return {
    status: blockedEvidence.length ? "blocked" : (doc.ok && support.ok && docRegistered && held ? "pass" : "fail"),
    detail: {
      freshState: true, caseId, actorUsed: actor, createAttempts: attempts, createHttp: created.status, documentHttp: doc.status, supportHttp: support.status,
      invariantsByStage: stages, documentActuallyRegistered: docRegistered,
      documentEvidence: {
        documentType: DOC_TYPE,
        statusBefore: docBefore?.status ?? null, statusAfter: docAfter?.status ?? null, statusAfterSupport: docPersisted?.status ?? null,
        objectIdRoundTripped: docAfter?.object_id === DOC_OBJECT_ID,
        checklistLengthConstant: Array.isArray(afterCreate?.documents) && Array.isArray(afterSupport?.documents) && afterCreate.documents.length === afterSupport.documents.length,
      },
      blockedEvidence: [...new Set(blockedEvidence)], moneyActionsInvoked: [],
      assertion: "quote/vendor/payment/refund asserted null-or-empty at every stage; the registered document asserted 'required'->'uploaded' with its exact object id, still true after the next mutation",
    },
  };
}

// A-13 passed in run #1352 and is CLOSED; its gate is removed rather than left dead in the file.

// A-13 is CLOSED/PASS from run #1352 and is deliberately NOT rerun.
const RUNNERS = [["journey-d-cross-provider", gateJourneyD], ["b07-payment-reconciliation", gateB07], ["journey-e-non-money", gateJourneyE]];
const REQUIRED_PERSONAS = ["manager", "associate", "finance", "rahul", "asha"];

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
