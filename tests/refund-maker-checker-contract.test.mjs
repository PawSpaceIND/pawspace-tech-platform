/**
 * Refund maker/checker segregation of duties — EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Three tests that read `app/api/booking-operations/route.ts` and
 * `backend/src/finance.ts` as strings. The first asserted that the token
 * `refund_self_approval_forbidden` and the SQL fragment
 * `approved_by=CASE WHEN ?='approved' THEN ? ELSE approved_by END` appeared in the source. Both would
 * have survived the guard being deleted and the identifier left behind in a log line, and neither ever
 * put a maker and a checker in the same room.
 *
 * Now each test drives the real POST handler against a real SQLite-backed D1 with real actors, and
 * reads `booking_refund_cases` back. Segregation of duties is a claim about two identities, so the
 * tests use two.
 *
 * Requests go to https://ops.pawspace.example, NOT localhost: `npm test` runs with NODE_ENV=test and
 * PAWSPACE_LOCAL_PREVIEW=on, and on a preview host lib/development-preview.ts hands back a superuser
 * holding ["*"] with a synthetic email — which would make every identity in this file the same actor
 * and the whole segregation claim untestable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__REFUND_MC_DB__", "__REFUND_MC_ENV__");

const operations = await import("../app/api/booking-operations/route.ts");

const MAKER = "maker.finance@pawspace.test";
const CHECKER = "checker.finance@pawspace.test";
const BOOKING = "BKG-REFUND-1";
const REFUND_CASE = "RFC-REFUND-1";
const OPS_URL = "https://ops.pawspace.example/api/booking-operations";

/**
 * Two finance staff, one booking, one refund case in `requested`, raised by MAKER.
 *
 * `finance` is the seeded role that actually holds payments.manage, which is what
 * REQUIRED_PERMISSION.refund_status demands — taken from lib/platform-security.ts rather than invented,
 * so a change to the role catalogue surfaces here.
 */
async function refundWorld({ requestedBy = MAKER, status = "requested", gatewayReference = null } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__REFUND_MC_DB__ = db;
  globalThis.__REFUND_MC_ENV__ = {};

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  const user = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'finance','active',?,?)");
  user.run("U-MAKER", MAKER, "Maker Finance", now, now);
  user.run("U-CHECKER", CHECKER, "Checker Finance", now, now);

  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT,service_code TEXT,status TEXT,total_amount REAL,scheduled_start TEXT,scheduled_end TEXT,city_id TEXT,zone_id TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,service_code,status,total_amount,created_at,updated_at) VALUES (?,?,?,'grooming','completed',2000,?,?)")
    .run(BOOKING, "CUST-REFUND-1", "groom_arun", now, now);
  // booking_lifecycle_events is WRITTEN by this route but created elsewhere (lib owns the DDL), so a
  // conversion that only relied on the route's own ensure* would 500 on the approval write. DDL copied
  // verbatim from the owning source.
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,gateway_reference,created_at,updated_at) VALUES (?,?,?,?,?,?,?,NULL,?,?,?)")
    .run(REFUND_CASE, BOOKING, `PAY-${BOOKING}`, 2000, "customer cancelled after completion", status, requestedBy, gatewayReference, now, now);

  return { sqlite, db };
}

const post = async (actorEmail, body) => {
  const response = await operations.POST(new Request(OPS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": actorEmail },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

// providerId is a REQUIRED routing field on this route ("Booking and provider are required"), which is
// exactly what makes the spoofing test below meaningful: the field must be present and must still not
// decide who is recorded as the approver.
const PROVIDER = "groom_arun";
const moveTo = (actorEmail, refundStatus) => post(actorEmail, { action: "refund_status", bookingId: BOOKING, providerId: PROVIDER, refundCaseId: REFUND_CASE, refundStatus, reason: "Finance reviewed the cancellation and the gateway record" });
const refundRow = (sqlite) => ({ ...sqlite.prepare("SELECT status,requested_by,approved_by FROM booking_refund_cases WHERE id=?").get(REFUND_CASE) });

// ---------------------------------------------------------------------------------------------
test("D1 refund workflow uses authenticated maker/checker identities and blocks self approval", async () => {
  const { sqlite } = await refundWorld();

  // THE SEGREGATION ITSELF: the actor who raised the refund cannot approve it.
  const selfApproval = await moveTo(MAKER, "approved");
  assert.equal(selfApproval.status, 409, `the requester must not approve their own refund: ${JSON.stringify(selfApproval).slice(0, 300)}`);
  assert.equal(selfApproval.body.code, "refund_self_approval_forbidden");
  assert.equal(refundRow(sqlite).status, "requested", "and the case must not move");
  assert.equal(refundRow(sqlite).approved_by, null, "nor gain an approver");

  // A DIFFERENT authenticated actor can approve, and the approver recorded is the ACTOR — never a value
  // from the request body. The old test could only pin the SQL that does this; here the row is read back.
  const approved = await moveTo(CHECKER, "approved");
  assert.equal(approved.status, 200, `a second finance actor may approve: ${JSON.stringify(approved).slice(0, 300)}`);
  const after = refundRow(sqlite);
  assert.equal(after.status, "approved");
  assert.equal(after.approved_by, CHECKER, "the approver is the authenticated checker");
  assert.equal(after.requested_by, MAKER, "and the maker is unchanged");

  // Identity cannot be supplied by the caller. Posting somebody else's email in the body must not
  // change who is recorded — this is the "requester identity must never come from providerId" claim,
  // executed.
  const fresh = await refundWorld();
  const spoofed = await post(CHECKER, {
    action: "refund_status", bookingId: BOOKING, refundCaseId: REFUND_CASE, refundStatus: "approved",
    providerId: PROVIDER, reason: "Finance reviewed the cancellation and the gateway record",
    requestedBy: CHECKER, approvedBy: MAKER, actorEmail: MAKER,
  });
  assert.equal(spoofed.status, 200);
  assert.equal(refundRow(fresh.sqlite).approved_by, CHECKER,
    "body-supplied identity fields must be ignored in favour of the resolved actor");
});

// ---------------------------------------------------------------------------------------------
test("refund state transition is claimed atomically before side effects", async () => {
  const { sqlite } = await refundWorld();

  // Only the transitions the state machine allows are accepted. `requested` may go to approved or
  // rejected — not straight to completed.
  const skipAhead = await moveTo(CHECKER, "completed");
  assert.equal(skipAhead.status, 409, `requested -> completed must be refused: ${JSON.stringify(skipAhead).slice(0, 250)}`);
  assert.match(String(skipAhead.body.error), /cannot move from requested to completed/);
  assert.equal(refundRow(sqlite).status, "requested");

  await moveTo(CHECKER, "approved");

  // THE CLAIM: the same transition applied twice moves the case exactly once. The second attempt is
  // refused because `requested -> approved` is no longer a legal move from the new state, and the
  // UNIQUE(refund_case_id,from_status) claim row is what makes the transition atomic rather than
  // last-writer-wins.
  const replay = await moveTo(CHECKER, "approved");
  assert.equal(replay.status, 409, `re-approving must be refused: ${JSON.stringify(replay).slice(0, 250)}`);
  assert.equal(refundRow(sqlite).status, "approved", "and the case stays where it was");

  const claims = sqlite.prepare("SELECT refund_case_id,from_status,to_status FROM booking_refund_transition_claims").all().map((row) => ({ ...row }));
  assert.equal(claims.length, 1, `exactly one claim was taken, not one per attempt: ${JSON.stringify(claims)}`);
  assert.deepEqual(claims[0], { refund_case_id: REFUND_CASE, from_status: "requested", to_status: "approved" });

  /*
   * TWO CONCURRENT approvals, INTERLEAVED IN THE REAL GAP.
   *
   * A plain Promise.all over two route calls does not test this: statements against the D1 shim are
   * synchronous, so the first call runs to completion before the second begins and no race occurs.
   * Measured — relaxing `INSERT OR IGNORE` to `INSERT OR REPLACE` on the claim table survived exactly
   * such a test. The hook below fires a competing transition in the window between this caller taking
   * its claim and applying its guarded UPDATE, which is the check-then-act window itself.
   *
   * One of the two must win and the other must be refused; the case must move once; and exactly one
   * claim may exist for the (case, from_status) pair.
   */
  const race = await refundWorld();
  let competitor = null;
  race.db.onSql("UPDATE booking_refund_cases SET status=?", async () => {
    competitor = await moveTo(CHECKER, "approved");
  });
  const first = await moveTo(CHECKER, "approved");

  assert.ok(competitor, "the competing transition really did run inside the window");
  const outcomes = [first.status, competitor.status].sort();
  assert.deepEqual(outcomes, [200, 409],
    `exactly one interleaved approval may win: ${JSON.stringify({ first, competitor }).slice(0, 400)}`);
  assert.equal(refundRow(race.sqlite).status, "approved", "and the case moved exactly once");
  assert.equal(refundRow(race.sqlite).approved_by, CHECKER);
  const raceClaims = race.sqlite.prepare("SELECT from_status,to_status FROM booking_refund_transition_claims").all().map((row) => ({ ...row }));
  assert.equal(raceClaims.length, 1,
    `one claim for one state change, however many callers arrived at once: ${JSON.stringify(raceClaims)}`);
});

// ---------------------------------------------------------------------------------------------
test("legacy backend cannot auto-approve a refund request for privileged roles", async () => {
  /*
   * The legacy backend path, EXECUTED against its real signature.
   *
   * THIS TEST WAS ITSELF VACUOUS on the first pass of this PR, and a review bot caught it. It called
   *
   *   finance.requestRefund(db, { actor, bookingId, amount, reason })
   *
   * but the real export is
   *
   *   requestRefund(repository: PlatformRepository, payment: Payment, actor: RequestActor,
   *                 amount: number, reason: string)
   *
   * — five positional arguments, and a repository rather than a D1 handle. So every call threw
   * `TypeError: repository.listRefunds is not a function`, a `.catch` turned the TypeError into a
   * "refusal is also acceptable" branch, and BOTH loop iterations hit `continue` before reaching a
   * single assertion. The test asserted nothing at all while reporting success — the exact defect
   * this whole PR exists to remove. Verified by running the call directly and reading the TypeError.
   *
   * It now uses MemoryRepository and the real signature, exactly as backend/test/finance.test.ts does,
   * and NOTHING is caught: an unexpected throw fails the test rather than being read as a refusal.
   */
  const finance = await import("../backend/src/finance.ts");

  /*
   * The repository is an injected PORT, and requestRefund touches exactly two of its methods:
   * listRefunds (to total what is already reserved) and createRefund (to persist). Both are
   * implemented here against a plain array.
   *
   * MemoryRepository from backend/src/repository.ts would be the natural choice and is NOT usable:
   * it declares a TypeScript constructor parameter property, which `node --experimental-strip-types`
   * cannot erase — the same limitation lib/gst-accounting.ts documents for its own class. Importing
   * it fails with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before any test runs. Verified.
   *
   * Faking the port does not weaken the test: every rule under test — the reservation arithmetic, the
   * born-requested status, the recorded maker, the absent approver — lives in finance.ts, and the
   * assertions below read the rows this port actually stored.
   */
  const makeRepository = () => {
    const refunds = [];
    return {
      refunds,
      async listRefunds(paymentId) { return refunds.filter((row) => !paymentId || row.paymentId === paymentId); },
      async createRefund(refund) { refunds.push(refund); return refund; },
    };
  };
  const payment = { id: "pay_refund_mc", bookingId: "book_refund_mc", amount: 2000 };

  for (const role of ["finance", "super_admin"]) {
    const repository = makeRepository();
    const actorId = `legacy-${role}@pawspace.test`;
    const refund = await finance.requestRefund(repository, payment, { id: actorId, role, cityId: "blr" }, 500, `${role} raised a refund`);

    // NON-VACUITY: the call really did create a refund. If the signature drifts again, this throws
    // rather than being swallowed into a pass.
    assert.ok(refund?.id, `requestRefund must return the created refund for ${role}: ${JSON.stringify(refund)}`);
    // THE CLAIM: however privileged the actor, the refund is born awaiting a checker.
    assert.equal(refund.status, "requested", `a ${role} actor's refund must be born requested`);
    assert.equal(refund.requestedBy, actorId, "and must record the maker who raised it");
    assert.equal(refund.approvedBy, undefined, `${role} must not be maker and checker in one call`);
    assert.equal(refund.amount, 500);

    // Read it back through the repository, so the assertion is about stored state and not just the
    // returned object.
    const stored = await repository.listRefunds(payment.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, "requested");
    assert.equal(stored[0].approvedBy, undefined);

    // A pending request RESERVES the balance, so a privileged actor cannot stack requests past the
    // captured amount while waiting for a checker. This is the guard the vacuous version never ran.
    await assert.rejects(
      () => finance.requestRefund(repository, payment, { id: actorId, role, cityId: "blr" }, 1600, "second bite"),
      /exceeds refundable balance/,
      `${role} must not reserve more than the payment holds`);
    assert.equal((await repository.listRefunds(payment.id)).length, 1, "and the refused request creates nothing");
  }
});
