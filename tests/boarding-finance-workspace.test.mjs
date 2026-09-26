/**
 * STAFF-02 — Finance had no screen for Boarding cancellations, refunds, date changes or invoices.
 *
 * The master E2E found a customer's Boarding cancellation visible only read-only in Operations, with
 * no /team/finance/boarding and no staff code calling approve_cancel, record_refund, apply_date_change
 * or issue_invoice: the tester had to POST /api/boarding-finance by hand. And when they did, every
 * governed refusal came back as "Unable to update Boarding finance" - the finance module refuses with
 * plain-text Responses, and the route handed them to authError, which redacts ungoverned errors.
 *
 * Everything here runs the real route, the real governance module and a real SQLite-backed D1. The
 * workspace's own client module is driven through a fetch that the route answers, on a NON-preview
 * host, so permission checks really run (a localhost request is handed a ["*"] superuser).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, seedBoardingStay, stayWindow, OPS_ORIGIN } from "./helpers/stay-harness.mjs";

installWorkersHooks("__BOARDING_FINANCE_WS_DB__", "__BOARDING_FINANCE_WS_ENV__");

const route = await import("../app/api/boarding-finance/route.ts");
const client = await import("../lib/boarding-finance-client.ts");
const finance = await import("../lib/boarding-finance-governance.ts");
const governance = await import("../lib/boarding-governance.ts");
const serverAuth = await import("../lib/server-auth.ts");
const gateway = await import("../lib/api-gateway.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const workspace = await import("../app/team/finance/boarding/boarding-finance-workspace.tsx");

const MAKER = "finance.maker@pawspace.in";
const CHECKER = "finance.checker@pawspace.in";
const DESK = "care.desk@pawspace.in"; // associate: bookings.view, no finance.view

async function world() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__BOARDING_FINANCE_WS_DB__ = db;
  globalThis.__BOARDING_FINANCE_WS_ENV__ = {};
  await serverAuth.ensureSecurityTables(db);
  for (const [id, email, role] of [["U-MAKER", MAKER, "finance"], ["U-CHECKER", CHECKER, "finance"], ["U-DESK", DESK, "associate"]]) {
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',1,1)").run(id, email, id, role);
  }
  // 2000 captured unless a test says otherwise, so the refund ceiling is a known number.
  const seed = (bookingId, options = {}) => seedBoardingStay(db, sqlite, { bookingId, customerId: `CUST-${bookingId}`, amount: 2000, ...options });
  const customer = (bookingId, action, extra = {}) => finance.mutateBoardingFinance(db, {
    bookingId, action, actorId: `customer:CUST-${bookingId}`, idempotencyKey: `${bookingId}:${action}:${crypto.randomUUID()}`,
    reason: "Our travel plans changed", ...extra,
  });
  const one = (sql, ...args) => sqlite.prepare(sql).get(...args);
  return { sqlite, db, seed, customer, one };
}

/** Run the workspace's client calls with a browser fetch that the real route answers as `email`. */
async function as(email, run) {
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), OPS_ORIGIN), method = String(init.method || "GET").toUpperCase();
    calls.push({ method, path: url.pathname + url.search, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const headers = new Headers(init.headers);
    if (email) headers.set("oai-authenticated-user-email", email);
    const request = new Request(url, { method, headers, body: init.body });
    return method === "POST" ? route.POST(request) : route.GET(request);
  };
  try { return { value: await run(), calls }; }
  catch (error) { return { error, calls }; }
  finally { globalThis.fetch = original; }
}

const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const count = (html, needle) => html.split(needle).length - 1;
const noop = () => {};
const noActions = { approveCancel: noop, recordRefund: noop, applyDateChange: noop, issueInvoice: noop, configureTax: noop, prepareSettlement: noop, reconcile: noop };

// ---------------------------------------------------------------------------------------------
test("STAFF-02 the Finance queue lists exactly the Boarding bookings waiting on a cancellation, refund or date-change decision", async () => {
  const { db, seed, customer } = await world();
  await seed("BKG-Q-CANCEL", { window: stayWindow({ startInHours: 48 }) });
  await seed("BKG-Q-MOVE", { window: stayWindow({ startInHours: 72 }) });
  await seed("BKG-Q-REFUND", { window: stayWindow({ startInHours: 96 }) });
  await seed("BKG-Q-CLEAR", { window: stayWindow({ startInHours: 120 }) });
  await seed("BKG-Q-SETTLED", { window: stayWindow({ startInHours: 144 }) });
  const decide = (bookingId, action, extra) => finance.mutateBoardingFinance(db, { bookingId, action, actorId: CHECKER, idempotencyKey: `${bookingId}:${action}`, reason: "Finance decision for the queue test", ...extra });

  await customer("BKG-Q-CANCEL", "request_cancel");
  const later = stayWindow({ startInHours: 200 });
  await customer("BKG-Q-MOVE", "request_date_change", { requestedStart: later.scheduledStart, requestedEnd: later.scheduledEnd });
  await customer("BKG-Q-REFUND", "request_cancel");
  await decide("BKG-Q-REFUND", "approve_cancel", { approvedRefundAmount: 750 });
  await customer("BKG-Q-SETTLED", "request_cancel");
  await decide("BKG-Q-SETTLED", "approve_cancel", { approvedRefundAmount: 300 });
  await decide("BKG-Q-SETTLED", "record_refund", { refundReference: "SBX-Q-SETTLED" });

  const { value: queue, error, calls } = await as(CHECKER, () => client.loadBoardingFinanceQueue());
  assert.equal(error, undefined, error?.message);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["GET /api/boarding-finance?view=queue"]);
  assert.deepEqual(queue.items.map((item) => item.booking_id), ["BKG-Q-CANCEL", "BKG-Q-MOVE", "BKG-Q-REFUND"],
    "a booking with nothing pending, or whose refund is already recorded, is not waiting on Finance");
  const row = Object.fromEntries(queue.items.map((item) => [item.booking_id, item]));
  assert.equal(Number(row["BKG-Q-CANCEL"].pending_cancellations), 1);
  assert.equal(Number(row["BKG-Q-MOVE"].pending_date_changes), 1);
  assert.equal(Number(row["BKG-Q-REFUND"].pending_refunds), 1);
  assert.equal(Number(row["BKG-Q-REFUND"].pending_refund_amount), 750);
  assert.equal(row["BKG-Q-REFUND"].booking_status, "cancelled", "an approved cancellation stays listed until its refund is recorded");

  // The screen draws that same list.
  const html = render(workspace.BoardingFinanceQueue, { queue, error: "", busy: false, onOpen: noop });
  const shown = text(html);
  for (const id of ["BKG-Q-CANCEL", "BKG-Q-MOVE", "BKG-Q-REFUND"]) assert.ok(shown.includes(id), `${id} is on screen`);
  for (const id of ["BKG-Q-CLEAR", "BKG-Q-SETTLED"]) assert.ok(!shown.includes(id), `${id} is not on screen`);
  assert.match(shown, /BKG-Q-CANCEL .*Cancellation awaiting policy review/);
  assert.match(shown, /BKG-Q-MOVE .*Date change awaiting a fresh quote/);
  assert.match(shown, /BKG-Q-REFUND .*Sandbox refund to record · ₹750/);
  assert.equal(count(html, ">Open booking</button>"), 3);
});

// ---------------------------------------------------------------------------------------------
test("STAFF-02 the Boarding finance screen is gated to Finance: the queue needs finance.view and actions need finance.manage", async () => {
  const { seed, customer, one } = await world();
  const { bookingId } = await seed("BKG-GATE");
  await customer(bookingId, "request_cancel");

  const anonymous = await route.GET(new Request(`${OPS_ORIGIN}/api/boarding-finance?view=queue`));
  assert.equal(anonymous.status, 401, "an anonymous caller is refused before any Boarding data is read");

  const desk = await as(DESK, () => client.loadBoardingFinanceQueue());
  assert.equal(desk.error?.message, "Permission denied", "staff without finance.view are shown the refusal, never an empty queue");
  const html = render(workspace.BoardingFinanceQueue, { queue: null, error: desk.error.message, busy: false, onOpen: noop });
  assert.match(html, /<p role="alert">Permission denied<\/p>/);
  assert.equal(count(html, "Open booking"), 0);

  const deskApproves = await as(DESK, () => client.approveBoardingCancellation({ bookingId, requestId: "any", approvedRefundAmount: 100, reason: "not finance" }));
  assert.equal(deskApproves.error?.message, "Permission denied", "an authorization refusal keeps its own sentence, not a re-read JSON envelope");
  assert.equal(one("SELECT COUNT(*) n FROM boarding_refund_ledger").n, 0);

  // The worker gateway asks for the same permissions before the route runs.
  assert.equal(await gateway.requiredPermission(new Request(`${OPS_ORIGIN}/api/boarding-finance?view=queue`)), "finance.view");
  assert.equal(await gateway.requiredPermission(new Request(`${OPS_ORIGIN}/api/boarding-finance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve_cancel" }) })), "finance.manage");
  assert.equal(await gateway.requiredPermission(new Request(`${OPS_ORIGIN}/api/boarding-finance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "issue_invoice" }) })), "finance.manage");

  // A bare read without a booking or the queue view is still the request error it always was.
  const bare = await route.GET(new Request(`${OPS_ORIGIN}/api/boarding-finance`));
  assert.equal(bare.status, 400);
});

// ---------------------------------------------------------------------------------------------
test("STAFF-02 each workspace action posts exactly what the route validates, and the server applies it", async () => {
  const { seed, customer, one } = await world();
  const { bookingId } = await seed("BKG-FLOW");
  const requested = await customer(bookingId, "request_cancel");
  assert.equal(requested.status, "policy_review_required");

  const approved = await as(CHECKER, () => client.approveBoardingCancellation({ bookingId, requestId: requested.requestId, approvedRefundAmount: 500, reason: "Refund approved under the stay policy" }));
  assert.equal(approved.error, undefined, approved.error?.message);
  assert.deepEqual(approved.calls.map((call) => call.body), [{ bookingId, action: "approve_cancel", approvedRefundAmount: 500, reason: "Refund approved under the stay policy", idempotencyKey: `boarding-finance:approve-cancel:${requested.requestId}` }]);
  assert.equal(approved.value.status, "cancelled");
  assert.equal(approved.value.refundStatus, "sandbox_pending");
  const refund = one("SELECT id,amount,status FROM boarding_refund_ledger WHERE booking_id=?", bookingId);
  assert.equal(Number(refund.amount), 500);
  assert.equal(one("SELECT decision_by FROM boarding_cancellation_requests WHERE id=?", requested.requestId).decision_by, CHECKER);

  const again = await as(CHECKER, () => client.approveBoardingCancellation({ bookingId, requestId: requested.requestId, approvedRefundAmount: 500, reason: "Refund approved under the stay policy" }));
  assert.equal(again.value.duplicatePrevented, true, "a second click replays the first decision");
  assert.equal(one("SELECT COUNT(*) n FROM boarding_refund_ledger WHERE booking_id=?", bookingId).n, 1, "and never writes a second refund");

  const recorded = await as(CHECKER, () => client.recordBoardingRefund({ bookingId, refundId: refund.id, refundReference: "SBX-RFND-1" }));
  assert.deepEqual(recorded.calls[0].body, { bookingId, action: "record_refund", refundReference: "SBX-RFND-1", idempotencyKey: `boarding-finance:refund:${refund.id}:SBX-RFND-1` });
  assert.equal(recorded.value.status, "sandbox_recorded");
  assert.deepEqual({ ...one("SELECT status,reference FROM boarding_refund_ledger WHERE id=?", refund.id) }, { status: "sandbox_recorded", reference: "SBX-RFND-1" });

  const reconciled = await as(CHECKER, () => client.reconcileBoardingFinance(bookingId));
  assert.equal(reconciled.calls[0].body.action, "reconcile");
  assert.match(reconciled.calls[0].body.idempotencyKey, new RegExp(`^boarding-finance:reconcile:${bookingId}:\\d+$`));
  assert.equal(reconciled.value.refundTotal, 500);

  const early = await as(CHECKER, () => client.prepareBoardingSettlement(bookingId));
  assert.deepEqual(early.calls[0].body, { bookingId, action: "prepare_settlement", idempotencyKey: `boarding-finance:settlement:${bookingId}` });
  assert.equal(early.error?.message, "Host settlement can be prepared only after canonical checkout");

  const tax = await as(CHECKER, () => client.saveBoardingFinanceTaxPolicy({ cityId: "blr", taxMode: "inclusive", taxRate: 18, effectiveFrom: "2026-09-01", reason: "GST 18% approved for Boarding" }));
  assert.deepEqual(tax.calls[0].body, { action: "save_tax_policy", cityId: "blr", taxMode: "inclusive", taxRate: 18, effectiveFrom: "2026-09-01", reason: "GST 18% approved for Boarding" });
  assert.equal(tax.value.status, "published");

  const invoice = await as(CHECKER, () => client.issueBoardingFinanceInvoice({ bookingId, reason: "Issue the stay invoice for the records" }));
  assert.deepEqual(invoice.calls[0].body, { action: "issue_invoice", bookingId, reason: "Issue the stay invoice for the records" });
  assert.match(String(invoice.value.invoiceNumber), /^BRD-BLR-\d{2}-\d{2}-000001$/);
  const reissued = await as(CHECKER, () => client.issueBoardingFinanceInvoice({ bookingId, reason: "Issue the stay invoice for the records" }));
  assert.equal(reissued.value.duplicatePrevented, true);
  assert.equal(reissued.value.invoiceNumber, invoice.value.invoiceNumber, "issuing again returns the same number");

  // What the screen shows after an action: the confirmation and the server's own response.
  const html = render(workspace.BoardingFinanceOutcome, { error: "", message: "Cancellation approved under explicit Finance authority.", response: approved.value });
  assert.match(html, /role="status"/);
  assert.match(text(html), /Server response/);
  assert.match(html, /&quot;refundStatus&quot;: &quot;sandbox_pending&quot;/);
  assert.match(html, /&quot;approvedRefundAmount&quot;: 500/);
});

// ---------------------------------------------------------------------------------------------
test("STAFF-02 a date change is applied with a fresh server quote, sending no blank adjustment reference", async () => {
  const { db, seed, customer, one } = await world();
  const { bookingId } = await seed("BKG-MOVE", { amount: 499 });
  const later = stayWindow({ startInHours: 72 });
  const requested = await customer(bookingId, "request_date_change", { requestedStart: later.scheduledStart, requestedEnd: later.scheduledEnd });
  assert.equal(requested.status, "commercial_quote_required");
  const quote = await governance.createBoardingQuote(db, { packageCode: "boarding-4h", petCount: 1, scheduledStart: later.scheduledStart, scheduledEnd: later.scheduledEnd, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" });

  const applied = await as(CHECKER, () => client.applyBoardingDateChange({ bookingId, requestId: requested.requestId, quoteId: quote.quoteId, paymentAdjustmentReference: "" }));
  assert.equal(applied.error, undefined, applied.error?.message);
  assert.deepEqual(applied.calls[0].body, { bookingId, action: "apply_date_change", quoteId: quote.quoteId, idempotencyKey: `boarding-finance:date-change:${requested.requestId}:${quote.quoteId}` });
  assert.equal(applied.value.status, "date_changed");
  assert.equal(one("SELECT scheduled_start FROM canonical_bookings WHERE id=?", bookingId).scheduled_start, later.scheduledStart);
  assert.equal(one("SELECT status FROM boarding_date_change_requests WHERE id=?", requested.requestId).status, "applied");
});

// ---------------------------------------------------------------------------------------------
test("STAFF-02 a governed refusal reaches the Finance screen in the server's own words", async () => {
  const { seed, one } = await world();
  const { bookingId } = await seed("BKG-REFUSE");

  // Policy review: nothing is waiting, so there is nothing to approve.
  const nothing = await as(CHECKER, () => client.approveBoardingCancellation({ bookingId, requestId: "none", approvedRefundAmount: 0, reason: "Nothing is pending" }));
  assert.equal(nothing.error?.message, "No cancellation request is awaiting policy review");

  // Maker/checker: Finance raises the request for the customer, then tries to approve it.
  const raised = await as(MAKER, () => client.requestBoardingFinanceChange({ bookingId, action: "request_cancel", idempotencyKey: "maker-raises", reason: "Customer phoned to cancel" }));
  assert.equal(raised.value.status, "policy_review_required");
  const self = await as(MAKER, () => client.approveBoardingCancellation({ bookingId, requestId: raised.value.requestId, approvedRefundAmount: 100, reason: "Approving my own request" }));
  assert.equal(self.error?.message, "Segregation of duties: the cancellation requester cannot approve their own refund");

  // Refund ceiling: 2000 was collected.
  const over = await as(CHECKER, () => client.approveBoardingCancellation({ bookingId, requestId: raised.value.requestId, approvedRefundAmount: 5000, reason: "Full refund please" }));
  assert.equal(over.error?.message, "Approved refund cannot exceed the amount actually collected for this booking (collected ₹2000). Boarding refunds are capped by captured funds, never by the booking total.");

  // Invoice before any tax policy.
  const invoice = await as(CHECKER, () => client.issueBoardingFinanceInvoice({ bookingId, reason: "Issue before any tax policy" }));
  assert.equal(invoice.error?.message, "Boarding invoice is blocked until a published tax policy is configured for this city");

  assert.equal(one("SELECT COUNT(*) n FROM boarding_refund_ledger").n, 0, "no refusal moved money");
  assert.equal(one("SELECT status FROM boarding_cancellation_requests WHERE id=?", raised.value.requestId).status, "policy_review_required");

  // The HTTP body carries the sentence itself; this is what the route used to redact.
  const raw = await route.POST(new Request(`${OPS_ORIGIN}/api/boarding-finance`, {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": CHECKER },
    body: JSON.stringify({ bookingId, action: "approve_cancel", idempotencyKey: "raw-over", approvedRefundAmount: 5000, reason: "Full refund please" }),
  }));
  assert.equal(raw.status, 409);
  assert.notEqual((await raw.json()).error, "Unable to update Boarding finance");

  // And the screen shows it as an alert, word for word.
  const html = render(workspace.BoardingFinanceOutcome, { error: self.error.message, message: "", response: null });
  assert.match(html, /<section role="alert"[^>]*>Segregation of duties: the cancellation requester cannot approve their own refund<\/section>/);
});

// ---------------------------------------------------------------------------------------------
test("STAFF-02 a loaded booking shows each action only on the row the server will act on", async () => {
  const { sqlite, seed, customer } = await world();
  const { bookingId } = await seed("BKG-ROWS");
  const first = await customer(bookingId, "request_cancel", { reason: "First request from the customer" });
  const second = await customer(bookingId, "request_cancel", { reason: "Second request from the customer" });
  // approve_cancel takes the NEWEST open request; make the order explicit rather than millisecond luck.
  sqlite.prepare("UPDATE boarding_cancellation_requests SET created_at=? WHERE id=?").run(1000, first.requestId);
  sqlite.prepare("UPDATE boarding_cancellation_requests SET created_at=? WHERE id=?").run(2000, second.requestId);

  const loaded = await as(CHECKER, () => client.loadBoardingFinance(bookingId));
  assert.deepEqual(loaded.calls.map((call) => `${call.method} ${call.path}`), [`GET /api/boarding-finance?bookingId=${bookingId}`]);
  const rowOf = (html, reason) => html.split("<div").find((chunk) => chunk.includes(reason));
  const before = render(workspace.BoardingFinanceBooking, { data: loaded.value, busy: false, on: noActions });
  assert.equal(count(before, ">Approve explicitly</button>"), 1);
  assert.ok(rowOf(before, "Second request from the customer").includes("Approve explicitly"), "the button sits on the request the server approves");
  assert.ok(!rowOf(before, "First request from the customer").includes("Approve explicitly"));
  assert.equal(count(before, ">Record sandbox refund</button>"), 0);
  assert.match(before, /<button disabled="">Prepare canonical settlement<\/button>/, "settlement waits for checkout");

  // Approving takes the newest request; the button moves to the one still waiting, and the refund appears.
  const approved = await as(CHECKER, () => client.approveBoardingCancellation({ bookingId, requestId: second.requestId, approvedRefundAmount: 250, reason: "Approved from the workspace" }));
  assert.equal(approved.error, undefined, approved.error?.message);
  const after = render(workspace.BoardingFinanceBooking, { data: (await as(CHECKER, () => client.loadBoardingFinance(bookingId))).value, busy: false, on: noActions });
  assert.ok(rowOf(after, "First request from the customer").includes("Approve explicitly"));
  assert.ok(!rowOf(after, "Second request from the customer").includes("Approve explicitly"));
  assert.equal(count(after, ">Record sandbox refund</button>"), 1);
  assert.match(text(after), /₹250 · sandbox pending Record sandbox refund/);
});

// ---------------------------------------------------------------------------------------------
test("STAFF-02 /team/finance/boarding renders the workspace, forwards ?bookingId and is linked from the Finance home", async () => {
  const page = await import("../app/team/finance/boarding/page.tsx");
  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ bookingId: "BKG-DEEP-LINK" }) }));
  assert.match(html, /<h1[^>]*>Boarding finance &amp; reconciliation<\/h1>/);
  assert.match(html, /value="BKG-DEEP-LINK"/);
  assert.match(html, /Loading pending Boarding requests…/, "the queue is requested on arrival, not only after a booking is typed in");
  assert.match(html, /href="\/team\/finance"/);

  const home = await import("../app/team/finance/page.tsx");
  const homeHtml = renderToStaticMarkup(React.createElement(home.default));
  assert.match(homeHtml, /<a [^>]*href="\/team\/finance\/boarding"[^>]*>Boarding finance<\/a>/);

  // Every button on the screen goes through the client calls exercised above.
  const source = readFileSync(new URL("../app/team/finance/boarding/boarding-finance-workspace.tsx", import.meta.url), "utf8");
  for (const call of [
    /approveBoardingCancellation\(\{bookingId:target,requestId:String\(row\.id\),approvedRefundAmount:amount,reason\}\)/,
    /recordBoardingRefund\(\{bookingId:target,refundId:String\(row\.id\),refundReference:reference\}\)/,
    /applyBoardingDateChange\(\{bookingId:target,requestId:String\(row\.id\),quoteId,paymentAdjustmentReference\}\)/,
    /issueBoardingFinanceInvoice\(\{bookingId:target,reason\}\)/,
    /saveBoardingFinanceTaxPolicy\(\{cityId:city,taxMode:mode as "inclusive"\|"exclusive",taxRate:rate,/,
    /act\(prepareBoardingSettlement,/,
    /act\(reconcileBoardingFinance,/,
  ]) assert.match(source, call);
});
