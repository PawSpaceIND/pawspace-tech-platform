/*
 * /team/finance-compliance told an operator the platform had broken whenever it had simply refused.
 *
 * lib/server-auth.ts authError() returns a thrown Response verbatim ONLY when isGovernedHttpError()
 * recognises it — membership in the module-private WeakSet in lib/governed-http-error.ts, by object
 * identity. An UNGOVERNED thrown Response keeps its status but has its body replaced by the route's
 * generic fallback; a plain Error becomes a 500 with that same fallback. Eleven of the thirteen
 * refusal paths behind POST /api/statutory-compliance therefore returned the identical string
 * "Unable to complete the statutory compliance action", so "Close & lock month" could not tell
 * "your checklist is incomplete" from "the platform is broken", and a TDS challan typed for the
 * wrong amount read the same as an outage. This is a month-close and tax-deposit surface.
 *
 * lib/subscription-plan-governance.ts updateSubscriptionPlan had the plain-Error version of the same
 * defect: every PATCH input refusal was a 500 + "Unable to update subscription plan".
 *
 * These tests EXECUTE the real library functions against a real SQLite-backed D1 and hand whatever
 * they throw to the REAL authError(), because the property at stake is what an operator receives,
 * not what the source says. Everything is loaded through importLibModule so lib/governed-http-error
 * is ONE module instance shared by the thrower and by authError — with two instances the WeakSet
 * lookup would fail by identity and the suite would prove nothing.
 *
 * The CONTROLs matter as much as the conversions: an ungoverned Response and a genuine platform
 * fault must STILL be redacted. A blanket 4xx that surfaces every throw would bury real defects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const { authError } = await importLibModule("server-auth");
const { isGovernedHttpError } = await importLibModule("governed-http-error");
const statutory = await importLibModule("statutory-compliance");
const tds = await importLibModule("tds-governance");
const close = await importLibModule("finance-monthly-close");
const plans = await importLibModule("subscription-plan-governance");

// The exact fallbacks the two real routes pass to authError().
const STATUTORY_FALLBACK = "Unable to complete the statutory compliance action";
const PLAN_FALLBACK = "Unable to update subscription plan";

const PERIOD = "2026-08";
const ACTOR = "finance@pawspace.test";

/** Run the real function, catch what it throws, and put it through the real authError(). */
async function surfaced(work, fallback) {
  let thrown;
  let returned;
  try { returned = await work(); } catch (error) { thrown = error; }
  assert.ok(thrown !== undefined, `the refusal must throw, it returned ${JSON.stringify(returned)}`);
  const response = authError(thrown, fallback);
  let error = "";
  try { error = String((await response.clone().json())?.error ?? ""); }
  catch { error = await response.clone().text(); }
  return { thrown, response, status: response.status, error };
}

/** A D1 whose statements matching `pattern` fail the way a real database failure does. */
function failingOn(db, pattern) {
  const boom = () => { throw new Error("D1_ERROR: disk image is malformed"); };
  const dead = { bind: () => dead, first: boom, run: boom, all: boom };
  return { ...db, prepare: (sql) => (pattern.test(sql) ? dead : db.prepare(sql)) };
}

async function financeWorld() {
  const w = freshCountingD1();
  await statutory.ensureStatutoryTables(w.db);
  await tds.ensureTdsTables(w.db);
  await close.ensureMonthlyCloseTables(w.db);
  return w;
}

// --- the two an operator hits on a real month close -------------------------------------------------

test("close_month blocked by the checklist names the unresolved item, as a 409", async () => {
  const w = await financeWorld();
  // Nothing else is red: revenue/GST/TDS compute, there is no payroll run and no TDS liability, and
  // the founder's monthly board approval has not been recorded. That is a refusal, not a fault.
  const seen = await surfaced(() => close.closeMonth(w.db, { period: PERIOD, actorId: ACTOR }), STATUTORY_FALLBACK);

  assert.equal(seen.status, 409, "an incomplete checklist is the operator's own state, not a server error");
  assert.equal(seen.error, "Close blocked - unresolved checklist items: board_approved");
  assert.notEqual(seen.error, STATUTORY_FALLBACK, "the generic fallback means authError() redacted the reason");
  assert.ok(isGovernedHttpError(seen.thrown), "it survives only because the Response is in the governed WeakSet");
});

test("record_tds_deposit with the wrong amount states the computed liability, as a 409", async () => {
  const w = await financeWorld();
  w.sqlite.prepare("INSERT INTO tds_deductions (id,period,section,deductee_type,deductee_id,deductee_name,pan_status,base_amount,rate_pct,tds_amount,source_type,source_ref,computed_at) VALUES ('TDS-1',?,'194H','provider','PRV-1','PRV-1','pending_verification',100000,2,2000,'provider_payouts','BKG-1',?)")
    .run(PERIOD, Date.UTC(2026, 7, 15));

  const seen = await surfaced(
    () => tds.recordTdsDeposit(w.db, { period: PERIOD, challanReference: "ITNS-281-4471", amount: 1500, actorId: ACTOR }),
    STATUTORY_FALLBACK,
  );

  assert.equal(seen.status, 409);
  assert.equal(seen.error, "Deposit must equal the computed liability of 2000 for 2026-08",
    "the operator must be told the number to type, not that the platform failed");
  // And the wrong deposit was not recorded.
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM tds_deposits WHERE period=?").get(PERIOD).c), 0);
});

// --- every remaining converted refusal on the statutory surface --------------------------------------

test("every statutory refusal reaches the operator with its own message and its own 4xx", async () => {
  const cases = [
    {
      name: "close_month on an already-closed month",
      status: 409,
      message: `${PERIOD} is already closed and locked; post corrections in the next open period`,
      run: async (w) => {
        await statutory.recordBoardApproval(w.db, { period: PERIOD, approvedBy: "founder@pawspace.test", approverRole: "founder" });
        const locked = await close.closeMonth(w.db, { period: PERIOD, actorId: ACTOR });
        assert.equal(locked.status, "closed", "the month really does close once the checklist is green");
        return close.closeMonth(w.db, { period: PERIOD, actorId: ACTOR });
      },
    },
    {
      name: "close_month with a malformed period",
      status: 400,
      message: "Close period must be YYYY-MM",
      run: (w) => close.closeMonth(w.db, { period: "2026-13", actorId: ACTOR }),
    },
    {
      name: "record_tds_deposit with a blank challan",
      status: 400,
      message: "Challan reference (ITNS-281) is required",
      run: (w) => tds.recordTdsDeposit(w.db, { period: PERIOD, challanReference: "   ", amount: 0, actorId: ACTOR }),
    },
    {
      name: "compute_tds with a malformed period",
      status: 400,
      message: "TDS period must be YYYY-MM",
      run: (w) => tds.computeMonthlyTds(w.db, { period: "2026-13", actorId: ACTOR }),
    },
    {
      name: "record_filing with a blank acknowledgement",
      status: 400,
      message: "A government acknowledgement reference is required to record a filing",
      run: (w) => statutory.recordStatutoryFiling(w.db, { obligationCode: "gstr1", period: PERIOD, acknowledgementRef: " ", actorId: ACTOR }),
    },
    {
      name: "board_approve with a bad period format",
      status: 400,
      message: "Board approval period must be YYYY-MM",
      run: (w) => statutory.recordBoardApproval(w.db, { period: "2026-8", approvedBy: ACTOR, approverRole: "founder" }),
    },
    {
      name: "file_tds_return before prepare",
      status: 409,
      message: "Prepare the quarterly return before marking it filed (or it is already filed)",
      run: (w) => tds.markTdsReturnFiled(w.db, { fyLabel: "FY2026-27", quarter: 2, form: "24Q", acknowledgementRef: "TRACES-ACK-77", actorId: ACTOR }),
    },
    {
      name: "file_tds_return with a blank acknowledgement",
      status: 400,
      message: "TRACES acknowledgement reference is required",
      run: (w) => tds.markTdsReturnFiled(w.db, { fyLabel: "FY2026-27", quarter: 2, form: "24Q", acknowledgementRef: "", actorId: ACTOR }),
    },
    {
      name: "prepare_tds_return with a malformed fyLabel",
      status: 400,
      message: "fyLabel must look like FY2026-27",
      run: (w) => tds.prepareTdsQuarterlyReturn(w.db, { fyLabel: "notafy", quarter: 2, form: "24Q", actorId: ACTOR }),
    },
  ];

  for (const item of cases) {
    const w = await financeWorld();
    const seen = await surfaced(() => item.run(w), STATUTORY_FALLBACK);
    assert.equal(seen.status, item.status, `${item.name}: wrong status (body ${JSON.stringify(seen.error)})`);
    assert.equal(seen.error, item.message, `${item.name}: the real reason did not survive authError()`);
    assert.ok(isGovernedHttpError(seen.thrown), `${item.name}: the Response is not in the governed WeakSet`);
  }
});

// --- CONTROLS: nothing else was widened --------------------------------------------------------------

test("CONTROL an UNGOVERNED thrown Response is still redacted to the route's fallback", async () => {
  // Byte-identical text and status to a real refusal — only the WeakSet membership differs. If this
  // ever returns its own body, authError() has stopped distinguishing governed refusals at all and
  // the suite above would pass for the wrong reason.
  const response = authError(new Response("Close blocked - unresolved checklist items: board_approved", { status: 409 }), STATUTORY_FALLBACK);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, STATUTORY_FALLBACK);
  assert.equal(isGovernedHttpError(new Response("x", { status: 409 })), false);
});

test("CONTROL a genuine platform fault inside the close is still a redacted 500", async () => {
  const w = await financeWorld();
  // provider_payout_computations EXISTS but its JOIN target provider_commercial_terms does not, so the
  // read-before-delete guard in computeMonthlyTds refuses with a plain Error. That is drift, not the
  // operator's input, and it must stay a 500 — a blanket 4xx would bury it.
  w.sqlite.exec("CREATE TABLE provider_payout_computations (id TEXT, booking_id TEXT, provider_id TEXT, provider_net_payout REAL, computed_at INTEGER, term_id TEXT)");

  const seen = await surfaced(() => close.closeMonth(w.db, { period: PERIOD, actorId: ACTOR }), STATUTORY_FALLBACK);
  assert.equal(seen.status, 500, "a source-read failure is a server fault");
  assert.equal(seen.error, STATUTORY_FALLBACK, "and it must leak nothing about the failure");
  assert.ok(seen.thrown instanceof Error && /refusing to recompute/.test(seen.thrown.message));
});

test("CONTROL a D1 failure while locking the month is still a redacted 500", async () => {
  const w = await financeWorld();
  await statutory.recordBoardApproval(w.db, { period: PERIOD, approvedBy: "founder@pawspace.test", approverRole: "founder" });
  const failing = failingOn(w.db, /^UPDATE finance_monthly_closes SET status='closed'/);

  const seen = await surfaced(() => close.closeMonth(failing, { period: PERIOD, actorId: ACTOR }), STATUTORY_FALLBACK);
  assert.equal(seen.status, 500);
  assert.equal(seen.error, STATUTORY_FALLBACK);
});

// --- updateSubscriptionPlan ---------------------------------------------------------------------------

async function planWorld() {
  const w = freshCountingD1();
  const plan = await plans.createSubscriptionPlan(w.db, {
    serviceCode: "grooming", planCode: "grooming-6", cityId: "blr", name: "Grooming 6",
    price: 6594, sessionCount: 6, validityValue: 8, validityUnit: "months",
    servicePackageCode: "grooming-full", actorId: ACTOR,
  });
  return { ...w, plan };
}

const patch = (db, plan, over = {}) => plans.updateSubscriptionPlan(db, {
  id: plan.id, changes: {}, reason: "Regression validation", actorId: ACTOR, ...over,
});

test("every updateSubscriptionPlan refusal is a 4xx carrying its own message", async () => {
  const cases = [
    { name: "reason below the 5-char minimum", over: { reason: "x", changes: { price: 6999 } }, status: 400, message: "A change reason (min 5 chars) is required" },
    { name: "unknown plan id", over: { id: "SPLAN-NOPE", changes: { price: 6999 } }, status: 404, message: "Subscription plan not found" },
    { name: "no editable field supplied", over: { changes: { plan_code: "other" } }, status: 400, message: "No supported plan fields supplied" },
    { name: "negative price", over: { changes: { price: -100 } }, status: 400, message: "A valid numeric price is required" },
    { name: "price as a string", over: { changes: { price: "6999" } }, status: 400, message: "A valid numeric price is required" },
    { name: "session_count below 1", over: { changes: { session_count: 0 } }, status: 400, message: "session_count and validity_value must be numeric values of at least 1" },
    { name: "validity_unit out of range", over: { changes: { validity_unit: "years" } }, status: 400, message: "validity_unit must be 'days' or 'months'" },
    { name: "active as a string", over: { changes: { active: "false" } }, status: 400, message: "active must be a boolean" },
  ];

  for (const item of cases) {
    const w = await planWorld();
    const seen = await surfaced(() => patch(w.db, w.plan, item.over), PLAN_FALLBACK);
    assert.equal(seen.status, item.status, `${item.name}: wrong status (body ${JSON.stringify(seen.error)})`);
    assert.equal(seen.error, item.message, `${item.name}: the real reason did not survive authError()`);
    assert.notEqual(seen.status, 500, `${item.name}: the admin's own input must never be reported as a server fault`);
    // The refusal writes nothing.
    const stored = w.sqlite.prepare("SELECT price,session_count,version FROM subscription_plans WHERE id=?").get(w.plan.id);
    assert.equal(Number(stored.price), 6594, `${item.name}: a refused change must not touch the plan`);
    assert.equal(Number(stored.version), 1, `${item.name}: a refused change must not bump the version`);
  }
});

test("updateSubscriptionPlan refusals stay Error objects, which assert.rejects(/regex/) requires", async () => {
  /*
   * REQUIREMENT PIN. tests/subscription-plan-governance.test.mjs (which must not be edited) asserts
   * these rejections with `assert.rejects(fn, /regex/)`, and node:assert matches a RegExp against
   * String(thrown): "Error: A valid numeric price is required" for an Error, the literal
   * "[object Response]" for a Response. So the create path's governedJsonError() CANNOT be reused
   * here — the refusal has to remain an Error and reach the caller through the
   * GOVERNED_CLIENT_ERROR bridge instead. This test fails first, and in this file, if anyone
   * "unifies" the two paths.
   */
  const w = await planWorld();
  let thrown;
  try { await patch(w.db, w.plan, { changes: { price: -100 } }); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof Error, "a Response here would make String(thrown) '[object Response]'");
  assert.match(String(thrown), /numeric price/i, "String(thrown) is what a RegExp assertion is matched against");
  assert.equal(thrown.statusCode, 400);
  // ...and it still becomes a governed 4xx on the wire.
  assert.ok(isGovernedHttpError(authError(thrown, PLAN_FALLBACK)));
});

test("CONTROL a D1 failure inside the plan UPDATE is still a redacted 500", async () => {
  const w = await planWorld();
  const failing = failingOn(w.db, /^UPDATE subscription_plans SET /);
  const seen = await surfaced(() => patch(failing, w.plan, { changes: { price: 6999 } }), PLAN_FALLBACK);
  assert.equal(seen.status, 500, "an unexpected write failure is not the admin's input");
  assert.equal(seen.error, PLAN_FALLBACK);
});

test("CONTROL an unbranded Error is still a redacted 500 even with a 4xx-looking statusCode", async () => {
  // The bridge is opt-in by symbol on purpose: an incidental `statusCode` from a fetch/undici/D1
  // internal error must not be enough to put its message in front of a caller.
  const response = authError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:5432"), { statusCode: 400 }), PLAN_FALLBACK);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, PLAN_FALLBACK);
});
