/*
 * The statutory compliance screen's missing operator controls. [FIN-W2-A]
 *
 * A1 (BLOCKER)  lib/finance-monthly-close.ts:138 makes `tds_pans_verified` a BLOCKING close-checklist
 *               item (`ok: tds.panPending===0`) and closeMonth() refuses while any item is red.
 *               app/api/statutory-compliance/route.ts implements `verify_tds_pan`, the only thing in
 *               the codebase that can clear it. NO .tsx posted that action:
 *                   grep -rn "verify_tds_pan" app lib   ->  the route, and nothing else.
 *               So a month that closed before the checklist item was added could no longer be closed
 *               by any human being. There was no typo to find and no error to read: the screen simply
 *               had no control, and "Close & lock month" does not even render unless the month is
 *               already `ready`.
 *
 * A2            Five more statutory actions were posted by no screen. Triaged below; none is
 *               machine-driven (lib/background-scheduler.ts runs exactly one statutory task,
 *               runStatutoryReminderSweep, already wired to "Run reminder sweep now"), so all of them
 *               are an operator's work with no operator surface. The GSTR-8 leg is the expensive one:
 *               a monthly return with a statutory due date (the 10th) that could not be computed,
 *               prepared or deposited from anywhere in the product.
 *
 * A3            Those TCS refusals were ungoverned - bare `new Error(...)` / `new Response(...)`, which
 *               lib/server-auth.ts authError() flattens to the route's generic fallback. A screen that
 *               says "Unable to complete the statutory compliance action" when the real reason is
 *               "provider PRV-KA has no GSTIN on file" is a screen an operator cannot act on.
 *
 * Everything below EXECUTES. The page is the real client component (its own hooks, effects, onClick
 * handlers and JSX branches), its fetch is wired to the REAL route handlers, and those run against a
 * real SQLite-backed D1 through the shared counting harness. No source text is scanned, and no assertion
 * stops at "an ingredient changed": each one ends at the outcome an operator wanted - the month closes,
 * the return is prepared, the challan is accepted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__W2A_STATUTORY_DB__");

// The page's UI barrel reaches recharts (-> redux) and OpsShell reaches next/navigation; neither can be
// linked by the synchronous loader hook and neither is on the path under test. Directory imports
// ("../../components/ui") also need index.ts resolution. Same stubs the pre-existing screen suite uses.
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const rechartsUrl = dataUrl("const noop=()=>null;export const ResponsiveContainer=noop,LineChart=noop,Line=noop,BarChart=noop,Bar=noop,XAxis=noop,YAxis=noop,CartesianGrid=noop,Tooltip=noop,Legend=noop;export default{};");
const navigationUrl = dataUrl('export const usePathname=()=>"/team/finance-compliance";export const useRouter=()=>({push(){},replace(){},refresh(){},back(){}});export const useSearchParams=()=>new URLSearchParams();export const useParams=()=>({});export const redirect=()=>{};export const notFound=()=>{};');

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "recharts") return { url: rechartsUrl, shortCircuit: true };
    if (specifier === "next/navigation" || specifier === "next/navigation.js") return { url: navigationUrl, shortCircuit: true };
    try { return nextResolve(specifier, context); }
    catch (error) {
      for (const candidate of [`${specifier}/index.ts`, `${specifier}/index.tsx`]) {
        try { return nextResolve(candidate, context); } catch { /* try the next one */ }
      }
      throw error;
    }
  },
});

const route = await import("../app/api/statutory-compliance/route.ts");
const closeEngine = await import("../lib/finance-monthly-close.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");

const ACTOR = "finance@pawspace.test";
const PERIOD = "2026-08";
/** Rs 1.5L/month = Rs 18L/year: above the s87A rebate, so the deduction (and the block) is real money. */
const MONTHLY_GROSS = 150_000;

// ---------------------------------------------------------------------------------------------
// A minimal React runtime: the real component, real hooks, no DOM.
// ---------------------------------------------------------------------------------------------

async function mount(modulePath) {
  const React = (await import("react")).default;
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const Component = (await import(modulePath)).default;
  const cells = [];
  let cursor = 0;
  let pending = [];

  const changed = (cell, deps) => !cell.deps || !deps || cell.deps.length !== deps.length || cell.deps.some((d, i) => !Object.is(d, deps[i]));
  const dispatcher = {
    useState(initial) {
      const cell = cells[cursor++] ??= { value: typeof initial === "function" ? initial() : initial };
      return [cell.value, (next) => { cell.value = typeof next === "function" ? next(cell.value) : next; }];
    },
    useCallback(fn, deps) { const cell = cells[cursor++] ??= {}; if (changed(cell, deps)) { cell.deps = deps; cell.value = fn; } return cell.value; },
    useMemo(fn, deps) { const cell = cells[cursor++] ??= {}; if (changed(cell, deps)) { cell.deps = deps; cell.value = fn(); } return cell.value; },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; },
    useEffect(fn, deps) { const cell = cells[cursor++] ??= {}; if (changed(cell, deps)) { cell.deps = deps; pending.push(fn); } },
  };
  dispatcher.useLayoutEffect = dispatcher.useEffect;

  function render() {
    const previous = internals.H;
    cursor = 0;
    internals.H = dispatcher;
    try { return Component(); } finally { internals.H = previous; }
  }
  async function settle() {
    for (let round = 0; round < 6 && pending.length; round += 1) {
      const queued = pending;
      pending = [];
      for (const effect of queued) effect();
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { render, settle };
}

const isElement = (node) => Boolean(node) && typeof node === "object" && "type" in node && "props" in node;

function walk(node, visit, ancestors = []) {
  if (node == null || typeof node === "boolean") return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit, ancestors); return; }
  if (!isElement(node)) return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  walk(node.props?.children, visit, next);
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (key !== "children" && (isElement(value) || Array.isArray(value))) walk(value, visit, next);
  }
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isElement(node)) return textOf(node.props?.children);
  return "";
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => { if (predicate(node)) found.push(node); });
  return found;
}
const clickable = (tree, label) => findAll(tree, (node) => typeof node.props?.onClick === "function" && textOf(node).trim() === label);
const inputLabelled = (tree, label) => findAll(tree, (node) => node.props?.["aria-label"] === label);
const panelsWithRole = (tree, role) => findAll(tree, (node) => node.props?.role === role);

/** One named section of the screen, so an assertion cannot be satisfied by a control somewhere else. */
function sectionUnder(tree, testId) {
  const found = findAll(tree, (node) => node.props?.["data-testid"] === testId);
  assert.equal(found.length, 1, `exactly one <section data-testid="${testId}"> must be on screen`);
  return found[0];
}

/** The PAN field for one deductee and the Verify button in that SAME row - never a neighbour's. */
function panRow(tree, deducteeId) {
  const found = [];
  walk(tree, (node, ancestors) => { if (node.props?.["aria-label"] === `PAN for ${deducteeId}`) found.push({ node, ancestors }); });
  assert.ok(found.length >= 1, `${deducteeId} must still have a PAN field on screen`);
  const row = found[0].ancestors.at(-1);
  const buttons = clickable(row, "Verify PAN");
  assert.equal(buttons.length, 1, `${deducteeId}'s own row must carry exactly one Verify PAN button`);
  return { input: found[0].node, button: buttons[0] };
}

// ---------------------------------------------------------------------------------------------
// One world: a real D1, the real route handlers behind globalThis.fetch, and the real screen.
// ---------------------------------------------------------------------------------------------

/** The source tables the close, the TDS engine and the s52 TCS engine read. DDL from the owning modules. */
function schema(sqlite) {
  sqlite.exec(`
    CREATE TABLE payroll_runs (id TEXT PRIMARY KEY, idempotency_key TEXT, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, status TEXT NOT NULL, input_snapshot_json TEXT, created_by TEXT, created_at INTEGER);
    CREATE TABLE employee_payroll_results (id TEXT PRIMARY KEY, run_id TEXT, employee_id TEXT, gross_earnings REAL);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, city_id TEXT, scheduled_start TEXT, status TEXT, total_amount REAL);
    CREATE TABLE food_orders (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT, total_amount REAL, created_at INTEGER);
    CREATE TABLE finance_invoices (id TEXT PRIMARY KEY, issue_date TEXT, status TEXT, tax_total REAL);
    CREATE TABLE finance_bills (id TEXT PRIMARY KEY, bill_date TEXT);
    CREATE TABLE finance_vendor_tax_reviews (id TEXT PRIMARY KEY, bill_id TEXT, review_status TEXT, eligible_tax_amount REAL);
    CREATE TABLE tax_registrations (entity_id TEXT, registration_reference TEXT, status TEXT, effective_from TEXT, effective_to TEXT, approved_at INTEGER);
    CREATE TABLE provider_commercial_terms (id TEXT PRIMARY KEY, engagement_model TEXT NOT NULL);
    CREATE TABLE provider_payout_computations (booking_id TEXT, provider_id TEXT, service_code TEXT, term_id TEXT, order_value REAL, provider_gst_deducted REAL, provider_net_payout REAL, computed_at INTEGER);
  `);
}

/** The two payroll runs the live database holds, to the millisecond, both already approved. */
function seedPayroll(sqlite, { employees = 1, gross = MONTHLY_GROSS } = {}) {
  const run = sqlite.prepare("INSERT INTO payroll_runs (id,period_start,period_end,status) VALUES (?,?,?,'approved')");
  run.run("SEEDRUN-AUG2026", Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 31, 23, 59, 59));
  const result = sqlite.prepare("INSERT INTO employee_payroll_results (id,run_id,employee_id,gross_earnings) VALUES (?,?,?,?)");
  for (let i = 0; i < employees; i += 1) result.run(`RES-SEED-${i}`, "SEEDRUN-AUG2026", `emp-seed-${i}`, gross);
  return { employees };
}

const OPERATOR_GSTIN = "29AABCP1234A1Z5";   // Karnataka, PawSpace itself
const KA_PROVIDER_GSTIN = "29AACCP9876B1Z2"; // Karnataka supplier -> intra-state -> CGST+SGST
/** Comfortably inside August 2026 IST, and after the 2024-07-10 s52 rate change, so the rate is 0.5%. */
const IN_PERIOD = Date.parse("2026-08-15T11:00:00+05:30");

function seedMarketplaceSupply(sqlite, { bookingId, providerId, orderValue, providerGst = 0 }) {
  sqlite.prepare("INSERT OR IGNORE INTO provider_commercial_terms (id,engagement_model) VALUES ('TERM-MKT','commission_standard')").run();
  sqlite.prepare("INSERT OR IGNORE INTO tax_registrations (entity_id,registration_reference,status,effective_from,effective_to,approved_at) VALUES ('pawspace_india',?,'active',NULL,NULL,1)").run(OPERATOR_GSTIN);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,status) VALUES (?,?,'blr','completed')").run(bookingId, `CUST-${bookingId}`);
  sqlite.prepare("INSERT INTO provider_payout_computations (booking_id,provider_id,service_code,term_id,order_value,provider_gst_deducted,provider_net_payout,computed_at) VALUES (?,?,'boarding','TERM-MKT',?,?,?,?)")
    .run(bookingId, providerId, orderValue, providerGst, orderValue - providerGst, IN_PERIOD);
}

/**
 * A world whose `fetch` is the REAL route. Nothing here is a stand-in for the API: the screen's own
 * fetch call reaches app/api/statutory-compliance/route.ts, which authorizes, runs the real engines
 * against this D1 and writes the real audit events.
 */
async function world() {
  const harness = freshCountingD1();
  schema(harness.sqlite);
  globalThis.__W2A_STATUTORY_DB__ = harness.db;
  await ensureSecurityTables(harness.db);

  const posts = [];
  globalThis.window = { prompt: () => "CHALLAN-W2A-1", confirm: () => true };
  globalThis.fetch = async (url, init) => {
    const absolute = new URL(String(url), "http://localhost:3000");
    const method = (init?.method || "GET").toUpperCase();
    const request = new Request(absolute, {
      method,
      headers: { ...(init?.headers || {}), origin: "http://localhost:3000" },
      body: init?.body,
    });
    if (method === "POST") { posts.push(JSON.parse(init.body)); return route.POST(request); }
    return route.GET(request);
  };
  return { ...harness, posts };
}

/** Post a body straight at the real handler, exactly as the screen would. */
async function post(body) {
  const response = await route.POST(new Request("http://localhost:3000/api/statutory-compliance", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

/** Mount the real screen on the real period, with its load effect already settled. */
async function screen() {
  const app = await mount("../app/team/finance-compliance/page.tsx");
  app.render();
  await app.settle();
  // The screen defaults to the CURRENT IST month; drive it to the period under test the way an
  // operator does, through the month picker, and let the load effect re-run.
  const picker = findAll(app.render(), (node) => node.props?.type === "month")[0];
  picker.props.onChange({ target: { value: PERIOD } });
  app.render();
  await app.settle();
  return { app, tree: app.render() };
}

const checklistItem = (view, key) => view.checklist.find((item) => item.key === key);

// =============================================================================================
// A1: the blocked month close, and the control that releases it
// =============================================================================================

test("A1 the close really is blocked by tds_pans_verified, and nothing but verify_tds_pan can clear it", async () => {
  const w = await world();
  seedPayroll(w.sqlite, { employees: 1 });

  // Everything else the close needs, done: liability computed + deposited, board approval recorded.
  const computed = await post({ action: "compute_tds", period: PERIOD });
  assert.equal(computed.status, 200, JSON.stringify(computed.body));
  assert.ok(computed.body.data.totalTds > 0, "the month has real TDS to block on");
  assert.equal(computed.body.data.panPending, 1);
  await post({ action: "record_tds_deposit", period: PERIOD, challanReference: "ITNS-281-W2A", amount: computed.body.data.totalTds });
  await post({ action: "board_approve", period: PERIOD, minutesReference: "BOARD-W2A" });

  const blocked = await closeEngine.monthlyCloseView(w.db, { period: PERIOD, actorId: ACTOR });
  assert.equal(checklistItem(blocked, "tds_deposited").ok, true);
  assert.equal(checklistItem(blocked, "board_approved").ok, true);
  assert.equal(checklistItem(blocked, "payroll_finalised").ok, true);
  assert.equal(checklistItem(blocked, "tds_pans_verified").ok, false, "the PAN item is the ONLY red one");
  assert.equal(blocked.status, "open");

  const refusal = await post({ action: "close_month", period: PERIOD });
  assert.equal(refusal.status, 409);
  assert.match(String(refusal.body.error), /tds_pans_verified/,
    "the close must refuse, and name the item - this is the state an operator was left stuck in");
});

test("A1 the screen offers the control, posts verify_tds_pan, and the month then CLOSES", async () => {
  const w = await world();
  seedPayroll(w.sqlite, { employees: 2 });
  const computed = await post({ action: "compute_tds", period: PERIOD });
  await post({ action: "record_tds_deposit", period: PERIOD, challanReference: "ITNS-281-W2A", amount: computed.body.data.totalTds });
  await post({ action: "board_approve", period: PERIOD, minutesReference: "BOARD-W2A" });

  const { app, tree } = await screen();

  // 1. The screen LISTS the unverified deductees, beside the close they are blocking AND in the TDS
  //    table where the deductees themselves are read. Both surfaces are load-bearing: an operator
  //    arrives at this screen either from a refused close or from the TDS register.
  assert.equal(clickable(sectionUnder(tree, "pan-verification"), "Verify PAN").length, 2,
    "the blocked close must offer a PAN control for each of its two unverified deductees");
  assert.equal(clickable(sectionUnder(tree, "tds-deductions"), "Verify PAN").length, 2,
    "and so must the TDS register, where the pending PAN status is read");
  const rendered = textOf(tree);
  assert.match(rendered, /2 deductee PAN\(s\) unverified/, "and say how many, and that they are what holds the month open");
  assert.match(rendered, /tds_pans_verified/, "naming the checklist item the operator is stuck on");
  for (const employee of ["emp-seed-0", "emp-seed-1"]) {
    assert.ok(rendered.includes(employee), `${employee} must be named so the operator knows whose PAN to fetch`);
    assert.equal(inputLabelled(tree, `PAN for ${employee}`).length >= 1, true, "with a field to enter that deductee's PAN");
  }
  assert.equal(clickable(tree, "Close & lock month").length, 0, "and the close button is not even offered while the month is open");

  // 2. The operator types each PAN and verifies it. The screen's fetch IS the real route.
  for (const [employee, pan] of [["emp-seed-0", "ABCDE1234F"], ["emp-seed-1", "PQRSX6789K"]]) {
    // Re-resolve the row each round: the previous verification removed a row from the list.
    panRow(app.render(), employee).input.props.onChange({ target: { value: pan } });
    panRow(app.render(), employee).button.props.onClick();
    await app.settle();
  }

  assert.deepEqual(w.posts.map((body) => body.action), ["verify_tds_pan", "verify_tds_pan"],
    "the screen posts the action the route implements - the one no .tsx posted before");
  assert.deepEqual(w.posts.map((body) => body.deducteeId).sort(), ["emp-seed-0", "emp-seed-1"]);
  assert.deepEqual(w.posts.map((body) => body.pan).sort(), ["ABCDE1234F", "PQRSX6789K"]);

  // 3. Only a masked reference was persisted, and it was stamped onto the deductions.
  const registry = w.sqlite.prepare("SELECT deductee_id,pan_reference,status,verified_by FROM tds_pan_registry ORDER BY deductee_id").all();
  assert.deepEqual(registry.map((row) => row.pan_reference), ["*****1234F", "*****6789K"]);
  assert.equal(JSON.stringify(registry).includes("ABCDE1234F"), false, "the full PAN must never be stored");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM tds_deductions WHERE period=? AND pan_status!='verified'").get(PERIOD).c), 0);

  // 4. THE OUTCOME: the checklist item flips, and the close that was refused now succeeds.
  const ready = await closeEngine.monthlyCloseView(w.db, { period: PERIOD, actorId: ACTOR });
  assert.equal(checklistItem(ready, "tds_pans_verified").ok, true);
  assert.equal(ready.status, "ready");

  const closed = await post({ action: "close_month", period: PERIOD });
  assert.equal(closed.status, 201, `the close must now succeed, got ${closed.status} ${JSON.stringify(closed.body)}`);
  assert.equal(closed.body.data.status, "closed");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM finance_monthly_closes WHERE period=?").get(PERIOD).status), "closed");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").get(PERIOD).status), "locked");
});

test("A1 the close button appears once the PANs are cleared, and locks the month from the screen", async () => {
  const w = await world();
  seedPayroll(w.sqlite, { employees: 1 });
  const computed = await post({ action: "compute_tds", period: PERIOD });
  await post({ action: "record_tds_deposit", period: PERIOD, challanReference: "ITNS-281-W2A", amount: computed.body.data.totalTds });
  await post({ action: "board_approve", period: PERIOD, minutesReference: "BOARD-W2A" });
  await post({ action: "verify_tds_pan", deducteeId: "emp-seed-0", pan: "ABCDE1234F" });

  const { app, tree } = await screen();
  assert.equal(clickable(tree, "Verify PAN").length, 0, "nothing is pending any more");
  const close = clickable(tree, "Close & lock month");
  assert.equal(close.length, 1, "the month is ready, so the screen offers the close");
  close[0].props.onClick();
  await app.settle();

  assert.equal(w.posts.at(-1).action, "close_month");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM finance_monthly_closes WHERE period=?").get(PERIOD).status), "closed",
    "the operator closed the month from the screen, start to finish");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0, "and was shown no failure");
});

test("A1 a refused verification shows the governed reason, not a generic failure", async () => {
  const w = await world();
  seedPayroll(w.sqlite, { employees: 1 });
  await post({ action: "compute_tds", period: PERIOD });

  // The route must refuse the operator's own bad input as a 4xx carrying its reason...
  const malformed = await post({ action: "verify_tds_pan", deducteeId: "emp-seed-0", pan: "NOTAPAN" });
  assert.equal(malformed.status, 400, "a malformed PAN is a business rule, never a 500");
  assert.equal(malformed.body.error, "PAN must be 10 characters in the form ABCDE1234F");
  const unknown = await post({ action: "verify_tds_pan", deducteeId: "emp-nobody", pan: "ABCDE1234F" });
  assert.equal(unknown.status, 404);
  assert.match(String(unknown.body.error), /No TDS deduction has been computed for emp-nobody/);
  assert.notEqual(unknown.body.error, "Unable to complete the statutory compliance action");

  // ...and the screen must put that reason in the red role="alert" panel, not the polite one.
  const { app, tree } = await screen();
  panRow(tree, "emp-seed-0").input.props.onChange({ target: { value: "NOTAPAN" } });
  panRow(app.render(), "emp-seed-0").button.props.onClick();
  await app.settle();
  const after = app.render();

  const alerts = panelsWithRole(after, "alert");
  assert.equal(alerts.length, 1, "a refusal must raise exactly one alert");
  assert.equal(textOf(alerts[0]), "PAN must be 10 characters in the form ABCDE1234F", "carrying the server's own wording");
  assert.equal(panelsWithRole(after, "status").length, 0, "and must not also read as a success");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM tds_pan_registry").get().c), 0, "nothing was written");
});

// =============================================================================================
// A2: GSTR-8 / s52 TCS - the other statutory filing with no operator surface
// =============================================================================================

test("A2 the GSTR-8 leg runs end to end from the screen: GSTIN -> compute -> prepare -> deposit", async () => {
  const w = await world();
  seedMarketplaceSupply(w.sqlite, { bookingId: "BKG-W2A-1", providerId: "PRV-KA", orderValue: 10_000, providerGst: 1_000 });

  // 1. Without a supplier GSTIN the whole month refuses - and the refusal NAMES the provider, as a
  //    4xx, so the operator can act on it. Before A3 this was a bare Error -> a redacted 500.
  const blocked = await post({ action: "compute_tcs", period: PERIOD });
  assert.equal(blocked.status, 409, "a supplier that cannot be identified must not be filed at zero");
  assert.match(String(blocked.body.error), /configuration_required:provider_gstin:PRV-KA/);
  assert.notEqual(blocked.body.error, "Unable to complete the statutory compliance action");

  const { app, tree } = await screen();
  assert.match(textOf(tree), /GST TCS \(s52\) & GSTR-8/, "the screen must carry the leg at all");

  // 2. The operator records the supplier's GSTIN from the screen's own control.
  inputLabelled(tree, "Provider id")[0].props.onChange({ target: { value: "PRV-KA" } });
  inputLabelled(app.render(), "Provider GSTIN")[0].props.onChange({ target: { value: KA_PROVIDER_GSTIN } });
  clickable(app.render(), "Save supplier GSTIN")[0].props.onClick();
  await app.settle();
  assert.equal(w.posts.at(-1).action, "save_provider_tax_profile");
  assert.equal(String(w.sqlite.prepare("SELECT gstin FROM finance_provider_tax_profiles WHERE provider_id='PRV-KA'").get().gstin), KA_PROVIDER_GSTIN);

  // 3. Recompute, from the screen. The month that refused now computes.
  clickable(app.render(), "Recompute TCS from payouts")[0].props.onClick();
  await app.settle();
  assert.equal(w.posts.at(-1).action, "compute_tcs");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0, "no refusal this time");
  const collected = w.sqlite.prepare("SELECT supplier_id,net_taxable_value,tcs_total FROM tcs_collections WHERE period=?").all(PERIOD);
  assert.equal(collected.length, 1);
  assert.equal(Number(collected[0].net_taxable_value), 9_000, "order value less the provider's own GST");
  assert.equal(Number(collected[0].tcs_total), 45, "0.5% of 9000");

  // 4. Prepare GSTR-8, from the screen.
  clickable(app.render(), "Prepare GSTR-8")[0].props.onClick();
  await app.settle();
  assert.equal(w.posts.at(-1).action, "prepare_gstr8");
  const statement = w.sqlite.prepare("SELECT total_tcs,supplier_count,status,prepared_by FROM tcs_statements WHERE period=?").get(PERIOD);
  assert.ok(statement, "the statement an operator signs must be on record, not just returned");
  assert.equal(Number(statement.total_tcs), 45);
  assert.equal(Number(statement.supplier_count), 1);
  assert.equal(String(statement.status), "prepared");

  // 5. Record the deposit, from the screen. The amount the screen sends is the one the engine checks.
  const depositButton = clickable(app.render(), "Record TCS deposit (₹45)");
  assert.equal(depositButton.length, 1, "the screen must offer the challan with the liability it computed");
  depositButton[0].props.onClick();
  await app.settle();
  assert.equal(w.posts.at(-1).action, "record_tcs_deposit");
  assert.equal(w.posts.at(-1).amount, 45, "the screen must send the liability, not a number the operator invents");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0, "the deposit must be accepted");

  const deposit = w.sqlite.prepare("SELECT amount,challan_reference,due_date FROM tcs_deposits WHERE period=?").get(PERIOD);
  assert.equal(Number(deposit.amount), 45);
  assert.equal(String(deposit.challan_reference), "CHALLAN-W2A-1");
  assert.equal(String(deposit.due_date), "2026-09-10", "s52 deposits are due the 10th of the following month");

  // 6. THE OUTCOME: the return reconciles, which is the thing a filing turns on.
  const reconciliation = await import("../lib/tds-tcs-reconciliation.ts");
  const result = await reconciliation.reconcileTcs(w.db, { period: PERIOD });
  assert.equal(result.summary.depositStatus, "matched");
  assert.equal(result.summary.reconciled, true, "statement, collections and challan all agree");
});

test("A2 a malformed supplier GSTIN is refused at the desk with its reason on screen", async () => {
  const w = await world();
  const { app, tree } = await screen();

  inputLabelled(tree, "Provider id")[0].props.onChange({ target: { value: "PRV-BAD" } });
  inputLabelled(app.render(), "Provider GSTIN")[0].props.onChange({ target: { value: "NOT-A-GSTIN" } });
  clickable(app.render(), "Save supplier GSTIN")[0].props.onClick();
  await app.settle();

  const alerts = panelsWithRole(app.render(), "alert");
  assert.equal(alerts.length, 1);
  assert.match(textOf(alerts[0]), /invalid_provider_gstin/, "the governed reason, not the route's fallback");
  assert.notEqual(textOf(alerts[0]), "Unable to complete the statutory compliance action");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM finance_provider_tax_profiles").get().c), 0);
});

test("A2 a TCS deposit that does not equal the liability is refused with the figure it must equal", async () => {
  const w = await world();
  seedMarketplaceSupply(w.sqlite, { bookingId: "BKG-W2A-2", providerId: "PRV-KA", orderValue: 10_000, providerGst: 1_000 });
  await post({ action: "save_provider_tax_profile", providerId: "PRV-KA", gstin: KA_PROVIDER_GSTIN });
  await post({ action: "compute_tcs", period: PERIOD });

  const wrong = await post({ action: "record_tcs_deposit", period: PERIOD, challanReference: "CHALLAN-WRONG", amount: 40 });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, "Deposit must equal the computed TCS liability of 45 for 2026-08",
    "an ungoverned thrown Response kept this status but lost this body to the route's fallback");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM tcs_deposits").get().c), 0);
});

// =============================================================================================
// A2: the reconciliation review
// =============================================================================================

test("A2 the screen renders the tax reconciliation and can re-run it for the record", async () => {
  const w = await world();
  seedPayroll(w.sqlite, { employees: 1 });
  await post({ action: "compute_tds", period: PERIOD });

  const { app, tree } = await screen();
  const rendered = textOf(tree);
  assert.match(rendered, /TDS\/TCS reconciliation/, "the leg the GET has always computed and nothing rendered");
  assert.match(rendered, /pan_pending/, "including the s206AA finding an operator must clear before filing");

  clickable(app.render(), "Re-run and record reconciliation")[0].props.onClick();
  await app.settle();
  assert.equal(w.posts.at(-1).action, "reconcile_partner_tax");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0);
  const audited = w.sqlite.prepare("SELECT action FROM security_audit_events WHERE action='statutory.reconcile_partner_tax'").all();
  assert.equal(audited.length, 1, "a review that is not on the audit trail is not a review");
});

// =============================================================================================
// A2 triage: every statutory action the route implements now has an operator surface
// =============================================================================================

test("A2 no statutory action the route implements is left without a way for a human to reach it", async () => {
  const w = await world();
  seedPayroll(w.sqlite, { employees: 1 });
  seedMarketplaceSupply(w.sqlite, { bookingId: "BKG-W2A-3", providerId: "PRV-KA", orderValue: 10_000 });
  await post({ action: "save_provider_tax_profile", providerId: "PRV-KA", gstin: KA_PROVIDER_GSTIN });
  await post({ action: "compute_tds", period: PERIOD });
  await post({ action: "compute_tcs", period: PERIOD });
  await post({ action: "prepare_tds_return", period: PERIOD, fyLabel: "FY2026-27", quarter: 2, form: "24Q" });

  const { tree } = await screen();
  const labels = findAll(tree, (node) => typeof node.props?.onClick === "function").map((node) => textOf(node).trim());

  // Every control an operator needs is on this one screen; each is exercised by a test above or by
  // tests/finance-compliance-failure-surface.test.mjs.
  for (const label of [
    "Verify PAN", "Recompute from source data", "Prepare quarterly return", "Mark filed", "Record filing",
    "Run reminder sweep now", "Record board approval",
    "Recompute TCS from payouts", "Prepare GSTR-8", "Save supplier GSTIN", "Re-run and record reconciliation",
  ]) assert.ok(labels.includes(label), `"${label}" must be on screen, found: ${[...new Set(labels)].join(" | ")}`);

  // The deposit buttons carry their amount in the label, so match by prefix.
  assert.ok(labels.some((label) => label.startsWith("Record deposit (")), "TDS deposit");
  assert.ok(labels.some((label) => label.startsWith("Record TCS deposit (")), "TCS deposit");
  assert.equal(w.posts.length, 0, "rendering posts nothing");
});
