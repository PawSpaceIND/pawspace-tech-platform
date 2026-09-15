/*
 * The GST return filing desk had no controls at all. [FIN-W2-G]
 *
 * G1 (BLOCKER)  app/api/gst-accounting/route.ts implements SIXTEEN actions. The only screen bound to
 *               that route, app/team/finance/statutory/page.tsx, issued one GET and posted nothing:
 *                   grep -rn "api/gst-accounting" app --include=*.tsx
 *                       -> app/team/finance/statutory/page.tsx  (a GET, twice)
 *                       -> app/control/finance-control-panel.tsx (a string in a caption)
 *               So no GST return could be prepared or signed off from the product: not GSTR-1 (due the
 *               11th), not GSTR-3B (due the 20th), not GSTR-9C, not the GSTR-9 annual return and not
 *               the monthly statutory package the annual return fails closed without. An invoice
 *               serial could not be voided, a credit note could not be issued, and input-tax credit
 *               could not be reviewed - so the ITC figure in GSTR-3B was structurally zero.
 *
 * G2 (TRIAGE)   None of it is machine driven. lib/background-scheduler.ts runs 25 sweeps and not one
 *               of them touches these engines; worker/index.ts adds cleanup, outbox, Razorpay,
 *               WhatsApp, executive, Atlas and DPDP tasks and none of them either. Every one of
 *               lib/gst-returns.ts, lib/finance-filing-closeout.ts, lib/statutory-invoicing.ts and the
 *               statutory half of lib/gst-accounting.ts is imported by the route and by nothing else.
 *               All sixteen are an operator's work. (issueAdjustment has two further machine callers -
 *               lib/subscription-billing.ts and lib/subscription-refund-reconciliation.ts issue
 *               subscription credit notes automatically - but that is a SECOND caller of the engine,
 *               not a reason Finance cannot issue a manual note for a booking invoice.)
 *
 * G3            Those refusals were ungoverned. The engines raise a business rule as a bare
 *               `throw new Error("credit_note_exceeds_invoice")`; lib/server-auth.ts authError()
 *               trusts only governed Responses, so the caller got HTTP 500 "GST/accounting action
 *               failed" - a server-fault status carrying no reason - for a missing approval reference,
 *               a stale annual return, a locked period or a self-approval. Now each named business
 *               rule reaches the operator as a readable 4xx.
 *
 * G4            Maker/checker. generate_* / approve_* pairs are enforced in the engines by
 *               prepared_by !== actor. The screen must not be usable to bypass that, so it does not
 *               offer an approve control on a draft the signed-in operator prepared - and the route
 *               still refuses if someone posts around the screen. Both are proven below.
 *
 * Everything here EXECUTES: the real client component with its real hooks and onClick handlers, its
 * fetch wired to the REAL route handlers, running against a real SQLite-backed D1, driven by two
 * DIFFERENT signed-in Finance identities. Every assertion ends at a statutory outcome - a return
 * prepared, a status flipped, a filing signed off - never at "an ingredient changed".
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__W2G_GST_DB__");

// The page's UI barrel reaches recharts (-> redux) and directory imports ("../../../components/ui")
// need index.ts resolution. Same stubs the pre-existing screen suites use.
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const rechartsUrl = dataUrl("const noop=()=>null;export const ResponsiveContainer=noop,LineChart=noop,Line=noop,BarChart=noop,Bar=noop,XAxis=noop,YAxis=noop,CartesianGrid=noop,Tooltip=noop,Legend=noop;export default{};");
const navigationUrl = dataUrl('export const usePathname=()=>"/team/finance/statutory";export const useRouter=()=>({push(){},replace(){},refresh(){},back(){}});export const useSearchParams=()=>new URLSearchParams();export const useParams=()=>({});export const redirect=()=>{};export const notFound=()=>{};');

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

const route = await import("../app/api/gst-accounting/route.ts");
const closeout = await import("../lib/finance-filing-closeout.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");

/** A real host (NOT a preview host), so the two identities below actually resolve as two people. */
const ORIGIN = "https://ops.pawspace.example";
const MAKER = "gst.maker@pawspace.test";
const CHECKER = "gst.checker@pawspace.test";
const READER = "gst.reader@pawspace.test";
const ENTITY = "ent_w2g";
const REGISTRATION = "taxreg_w2g";
const POLICY = "taxpol_w2g";
const GSTIN = "29AABCP1234A1Z5";
const PERIOD = "2026-08";
const FY = "2026-27";

/** Every action any control on the screen actually posted, accumulated across the whole suite. */
const postedActions = new Set();

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
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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

/** Type into a labelled field and re-render, the way an operator does. */
function type(app, label, value) {
  const fields = inputLabelled(app.render(), label);
  assert.ok(fields.length >= 1, `the screen must carry a "${label}" field`);
  fields[0].props.onChange({ target: { value } });
  return app.render();
}

/** Click a control by its exact visible text and let the post + reload settle. */
async function click(app, label) {
  const buttons = clickable(app.render(), label);
  assert.equal(buttons.length, 1, `exactly one "${label}" control must be on screen, found ${buttons.length}`);
  buttons[0].props.onClick();
  await app.settle();
  return app.render();
}

// ---------------------------------------------------------------------------------------------
// One world: a real D1, two real signed-in Finance identities, the real route behind fetch.
// ---------------------------------------------------------------------------------------------

/** Tables the statutory engines read but do not own. DDL copied from the owning modules. */
function schema(sqlite) {
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, city_id TEXT, scheduled_start TEXT, status TEXT, total_amount REAL);
  `);
}

function seedIdentities(sqlite) {
  const now = Date.now();
  const insert = sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  insert.run("u-maker", MAKER, "GST maker", "finance", now, now);
  insert.run("u-checker", CHECKER, "GST checker", "finance", now, now);
  // `admin` carries finance.view but NOT finance.manage - the read-only statutory reviewer.
  insert.run("u-reader", READER, "GST reader", "admin", now, now);
}

/** The Finance/CA-approved configuration a statutory invoice legitimately requires. */
function seedConfiguration(sqlite) {
  const now = Date.UTC(2026, 7, 1);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?)")
    .run(ENTITY, "PawSpace India Pvt Ltd", "IN", "board", now, now, now);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'KA','GSTIN',?,'active','2026-04-01',NULL,'board',?,?,?)")
    .run(REGISTRATION, ENTITY, GSTIN, now, now, now);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,1,'active','2026-04-01',NULL,?,?,?,?,?,?)")
    .run(POLICY, ENTITY, JSON.stringify({ regime: "gst_in" }), "BOARD-2026-01", "board", now, now, now);
  sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES ('cls_w2g',?,'pet_grooming','SAC998729',?,'service_location','eligible',?)")
    .run(POLICY, JSON.stringify([{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]), now);
  for (const [documentType, prefix] of [["invoice", "PS/26-27/"], ["credit_note", "CN/26-27/"], ["debit_note", "DN/26-27/"]]) {
    sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES (?,?,?,?,1,6,?,'active',?)")
      .run(`ser_${documentType}`, ENTITY, documentType, prefix, POLICY, now);
  }
  sqlite.prepare("INSERT INTO finance_customer_tax_profiles (customer_id,registration_reference,customer_type,place_of_supply,status,updated_at) VALUES ('CUST-W2G',NULL,'consumer','29','approved',?)").run(now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,status,total_amount) VALUES ('BKG-W2G','CUST-W2G','blr','completed',11800)").run();
  // One vendor bill in the period, and the posted journals an accounting export carries.
  sqlite.prepare("INSERT INTO finance_bills (id,entity_id,vendor_id,bill_number,bill_date,due_date,cost_centre,vertical,taxable_amount,gst_amount,tds_amount,total_amount,status,created_at,updated_at) VALUES ('BILL-W2G',?,'VEN-1','SUP-1','2026-08-12','2026-09-12','ops','grooming',5000,900,0,5900,'approved',?,?)")
    .run(ENTITY, now, now);
  sqlite.prepare("INSERT INTO finance_journal_entries (id,entity_id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) VALUES ('JE-W2G',?,'2026-08-12','bill','BILL-W2G','5100','ops','grooming',5000,0,'grooming supplies',?,1,?)")
    .run(ENTITY, PERIOD, now);
  sqlite.prepare("INSERT INTO accounting_mapping_versions (id,entity_id,version,status,effective_from,mapping_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES ('map_w2g',?,1,'active','2026-04-01',?,'BOARD-MAP-1','board',?,?,?)")
    .run(ENTITY, JSON.stringify({ "5100": "Indirect expenses" }), now, now, now);
}

let currentActor = MAKER;

/**
 * A world whose `fetch` IS the real route. The page's own fetch reaches
 * app/api/gst-accounting/route.ts, which resolves the signed-in identity, authorizes on the
 * permission the route itself requires, runs the real statutory engines against this D1 and writes
 * the real audit events.
 */
async function world() {
  const harness = freshCountingD1();
  globalThis.__W2G_GST_DB__ = harness.db;
  await ensureSecurityTables(harness.db);
  await closeout.ensureFinanceEntityScope(harness.db);
  schema(harness.sqlite);
  seedIdentities(harness.sqlite);
  seedConfiguration(harness.sqlite);

  const posts = [];
  currentActor = MAKER;
  globalThis.fetch = async (url, init) => {
    const absolute = new URL(String(url), ORIGIN);
    const method = (init?.method || "GET").toUpperCase();
    const request = new Request(absolute, {
      method,
      headers: { ...(init?.headers || {}), origin: ORIGIN, "oai-authenticated-user-email": currentActor },
      body: init?.body,
    });
    if (method === "POST") {
      const body = JSON.parse(init.body);
      posts.push(body);
      postedActions.add(String(body.action || ""));
      return route.POST(request);
    }
    return route.GET(request);
  };
  return { ...harness, posts };
}

/** Post a body straight at the real handler as `actor`, exactly as the screen would. */
async function post(actor, body) {
  const response = await route.POST(new Request(`${ORIGIN}/api/gst-accounting`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "oai-authenticated-user-email": actor },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

/** Mount the real screen as `actor`, with its load effect settled and the filing scope chosen. */
async function screen(actor, { period = PERIOD, financialYear = FY } = {}) {
  currentActor = actor;
  const app = await mount("../app/team/finance/statutory/page.tsx");
  app.render();
  await app.settle();
  type(app, "Return period", period);
  type(app, "Financial year", financialYear);
  return { app, tree: app.render() };
}

const returnRows = (sqlite) => sqlite.prepare("SELECT id,return_type,period_code,status,prepared_by,reviewed_by,approval_reference,summary_json FROM gst_return_documents ORDER BY prepared_at").all();

/** Issue one canonical tax invoice from the screen, so the returns below have real content. */
async function issueInvoiceFromScreen(app) {
  type(app, "Invoice customer", "CUST-W2G");
  type(app, "Invoice source id", "BKG-W2G");
  type(app, "Invoice issue date", "2026-08-12");
  type(app, "Invoice service code", "pet_grooming");
  type(app, "Invoice taxable amount", "10000");
  type(app, "Invoice reason", "Grooming package for August");
  return click(app, "Issue canonical invoice");
}

// =============================================================================================
// G1: the monthly returns nothing could prepare
// =============================================================================================

test("G1 the screen prepares GSTR-1 and GSTR-3B for the month, from real invoice truth", async () => {
  const w = await world();
  const { app } = await screen(MAKER);

  // Precondition, not an assumption: before the clicks there is no return for this period at all.
  assert.equal(returnRows(w.sqlite).length, 0);

  await issueInvoiceFromScreen(app);
  assert.equal(panelsWithRole(app.render(), "alert").length, 0, `issuing must succeed: ${textOf(panelsWithRole(app.render(), "alert")[0])}`);
  const invoice = w.sqlite.prepare("SELECT invoice_number,subtotal,tax_total,status FROM finance_invoices").get();
  assert.ok(invoice, "the canonical invoice an operator issued must be on record");
  assert.equal(Number(invoice.subtotal), 10_000);
  assert.equal(Number(invoice.tax_total), 1_800, "CGST 9% + SGST 9% on an intra-state Karnataka supply");

  await click(app, "Generate GSTR-1");
  await click(app, "Generate GSTR-3B");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0);

  const rows = returnRows(w.sqlite);
  assert.deepEqual(rows.map((row) => row.return_type), ["GSTR-1", "GSTR-3B"], "both monthly returns are now on record");
  for (const row of rows) {
    assert.equal(String(row.period_code), PERIOD);
    assert.equal(String(row.status), "draft");
    assert.equal(String(row.prepared_by), MAKER, "the return records who prepared it - the whole basis of maker/checker");
  }

  // THE OUTCOME: the drafts carry the month's real statutory figures, not an empty shell.
  const gstr1 = JSON.parse(String(rows[0].summary_json));
  assert.equal(gstr1.canonicalTaxableValue, 10_000);
  assert.equal(gstr1.canonicalOutputTax, 1_800);
  assert.equal(gstr1.b2cInvoices, 1);
  const gstr3b = JSON.parse(String(rows[1].summary_json));
  assert.equal(gstr3b.totalOutputTax, 1_800);
  assert.equal(gstr3b.eligibleInputTax, 0, "no vendor bill has been reviewed yet, so no credit is claimed");
  assert.equal(gstr3b.netTaxPayable, 1_800);
});

test("G1 reviewing input-tax credit from the screen changes the tax actually payable in GSTR-3B", async () => {
  const w = await world();
  const { app } = await screen(MAKER);
  await issueInvoiceFromScreen(app);
  await click(app, "Generate GSTR-3B");
  assert.equal(JSON.parse(String(returnRows(w.sqlite).at(-1).summary_json)).netTaxPayable, 1_800);

  type(app, "Vendor bill id", "BILL-W2G");
  type(app, "Supplier invoice number", "SUP-1");
  type(app, "Supplier GSTIN", "29AAAAA0000A1Z5");
  type(app, "Eligible tax amount", "900");
  type(app, "Review reason", "Tax invoice and GSTR-2B both match the bill");
  await click(app, "Record vendor tax review");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0);
  assert.equal(String(w.sqlite.prepare("SELECT review_status FROM finance_vendor_tax_reviews WHERE bill_id='BILL-W2G'").get().review_status), "eligible");

  await click(app, "Generate GSTR-3B");
  const latest = JSON.parse(String(returnRows(w.sqlite).at(-1).summary_json));
  assert.equal(latest.eligibleInputTax, 900, "the reviewed credit now reaches the return");
  assert.equal(latest.netTaxPayable, 900, "and the tax the company actually pays for the month halves");
});

// =============================================================================================
// G4: maker/checker - the generator cannot approve their own return
// =============================================================================================

test("G4 the maker is not offered the approve control, and is refused if they post around the screen", async () => {
  const w = await world();
  const { app } = await screen(MAKER);
  await issueInvoiceFromScreen(app);
  await click(app, "Generate GSTR-1");
  const draft = returnRows(w.sqlite)[0];
  assert.equal(String(draft.prepared_by), MAKER);

  // 1. The screen refuses to offer the control at all, and says why.
  const returns = sectionUnder(app.render(), "gst-returns");
  assert.equal(clickable(returns, "Approve return").length, 0, "the maker must not be offered an approve control on their own draft");
  const hold = findAll(returns, (node) => node.props?.["data-testid"] === "maker-checker-hold");
  assert.equal(hold.length, 1, "and the screen must say the draft is held, not silently omit the button");
  assert.match(textOf(hold[0]), /you prepared this draft, so you cannot approve it/);
  assert.equal(inputLabelled(returns, `Approval reference for ${draft.id}`).length, 0, "not even a reference field");

  // 2. Posting around the screen still fails, as a readable 4xx rather than a 500.
  const refused = await post(MAKER, { action: "approve_gst_return", id: draft.id, approvalReference: "CA-SELF-1", reason: "self approval" });
  assert.equal(refused.status, 409, "a business rule is a 4xx, never a server fault");
  assert.equal(refused.body.error, "Two-person rule: whoever prepared this draft cannot approve it. A different Finance/CA approver must sign it off.");
  assert.notEqual(refused.body.error, "GST/accounting action failed");

  // 3. THE OUTCOME: nothing moved.
  const after = returnRows(w.sqlite)[0];
  assert.equal(String(after.status), "draft");
  assert.ok(!String(after.reviewed_by || ""), "reviewed_by is still empty");
  assert.deepEqual(after, draft, "the refused approval left the row byte-for-byte unchanged");
});

test("G4 a DIFFERENT approver signs the return off from the screen, and the return is reviewed", async () => {
  const w = await world();
  const maker = await screen(MAKER);
  await issueInvoiceFromScreen(maker.app);
  await click(maker.app, "Generate GSTR-1");
  const draft = returnRows(w.sqlite)[0];

  // A second human opens the same screen. Same code, different signed-in identity.
  const { app } = await screen(CHECKER);
  const returns = sectionUnder(app.render(), "gst-returns");
  assert.equal(findAll(returns, (node) => node.props?.["data-testid"] === "maker-checker-hold").length, 0, "the checker is not the maker, so nothing is held");
  assert.equal(clickable(returns, "Approve return").length, 1, "and the approve control is offered to them");

  type(app, `Approval reference for ${draft.id}`, "CA-SIGNOFF-W2G-1");
  await click(app, "Approve return");

  assert.equal(panelsWithRole(app.render(), "alert").length, 0, "the approval must be accepted");
  assert.equal(panelsWithRole(app.render(), "status").length, 1, "and the operator told it worked");

  // THE OUTCOME: the return is signed off, by the other human, with their reference, on the audit trail.
  const signed = returnRows(w.sqlite)[0];
  assert.equal(String(signed.status), "reviewed");
  assert.equal(String(signed.reviewed_by), CHECKER);
  assert.equal(String(signed.approval_reference), "CA-SIGNOFF-W2G-1");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM gst_accounting_audit_events WHERE entity_type='gst_return' AND action='reviewed'").get().c), 1);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM security_audit_events WHERE action='gst.accounting.approve_gst_return'").get().c), 1,
    "a sign-off that is not on the security audit trail is not a sign-off");

  // And the screen now reads back as signed off rather than offering the control again.
  const reloaded = await screen(CHECKER);
  assert.equal(clickable(sectionUnder(reloaded.tree, "gst-returns"), "Approve return").length, 0);
  assert.match(textOf(sectionUnder(reloaded.tree, "gst-returns")), /signed off by gst\.checker@pawspace\.test/);
});

// =============================================================================================
// G3: a business rule must reach the operator as a readable 4xx, never a generic 500
// =============================================================================================

test("G3 a missing approval reference is refused at the desk with the server's own wording", async () => {
  const w = await world();
  const maker = await screen(MAKER);
  await issueInvoiceFromScreen(maker.app);
  await click(maker.app, "Generate GSTR-1");
  const draft = returnRows(w.sqlite)[0];

  const direct = await post(CHECKER, { action: "approve_gst_return", id: draft.id, reason: "no reference supplied" });
  assert.equal(direct.status, 400, "a missing reference is the operator's own input, never a server fault");
  assert.equal(direct.body.error, "An approval reference (the CA/Finance sign-off) is required before this can be approved.");

  const { app } = await screen(CHECKER);
  await click(app, "Approve return");
  const alerts = panelsWithRole(app.render(), "alert");
  assert.equal(alerts.length, 1, "a refusal must raise exactly one alert");
  assert.equal(textOf(alerts[0]), "An approval reference (the CA/Finance sign-off) is required before this can be approved.",
    "carrying the server's own wording, not the route's generic fallback");
  assert.equal(panelsWithRole(app.render(), "status").length, 0, "and must not also read as a success");
  assert.equal(String(returnRows(w.sqlite)[0].status), "draft", "and nothing was written");
});

test("G3 a credit note larger than the invoice it adjusts is refused with the reason, not a 500", async () => {
  const w = await world();
  const { app } = await screen(MAKER);
  await issueInvoiceFromScreen(app);
  const invoiceId = String(w.sqlite.prepare("SELECT id FROM finance_invoices").get().id);

  const refused = await post(MAKER, { action: "issue_adjustment", invoiceId, kind: "credit_note", amount: 25_000, taxAmount: 4_500, reason: "over-credit", sourceEventKey: "w2g:over" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "Credit notes against this invoice would exceed the invoice they adjust.");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM finance_adjustment_documents").get().c), 0, "and nothing was issued");

  // The legitimate note goes through from the screen, and lands on the statutory register.
  type(app, "Adjustment taxable amount", "1000");
  type(app, "Adjustment tax amount", "180");
  type(app, "Adjustment reason", "Partial groom not delivered");
  const picker = inputLabelled(app.render(), "Invoice to adjust")[0];
  picker.props.onChange({ target: { value: invoiceId } });
  app.render();
  await click(app, "Issue adjustment note");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0, `the note must be accepted: ${textOf(panelsWithRole(app.render(), "alert")[0])}`);

  const note = w.sqlite.prepare("SELECT document_number,kind,amount,tax_amount,status FROM finance_adjustment_documents").get();
  assert.equal(String(note.kind), "credit_note");
  assert.equal(Number(note.amount), 1_000);
  assert.equal(String(note.status), "issued");
  assert.equal(Number(w.sqlite.prepare("SELECT COALESCE(SUM(amount),0) a FROM finance_tax_ledger WHERE ledger_type='adjustment'").get().a), -180,
    "and the credit reversed output tax in the ledger the return reads");
});

// =============================================================================================
// G1: the annual chain - monthly package -> GSTR-9 -> GSTR-9C
// =============================================================================================

test("G1 the monthly package is prepared and signed off by two people from the screen", async () => {
  const w = await world();
  const maker = await screen(MAKER);
  await issueInvoiceFromScreen(maker.app);
  await click(maker.app, "Generate statutory package");

  const packages = sectionUnder(maker.app.render(), "statutory-package");
  assert.equal(clickable(packages, "Approve statutory package").length, 0, "the maker cannot sign off their own package either");

  const draft = w.sqlite.prepare("SELECT id,status,prepared_by,summary_json FROM finance_statutory_packages").get();
  assert.equal(String(draft.status), "draft");
  assert.equal(String(draft.prepared_by), MAKER);
  assert.equal(JSON.parse(String(draft.summary_json)).outputTax, 1_800, "the package carries the month's real output tax");

  const { app } = await screen(CHECKER);
  type(app, `Approval reference for ${draft.id}`, "CA-PKG-2026-08");
  await click(app, "Approve statutory package");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0);

  const signed = w.sqlite.prepare("SELECT status,reviewed_by,approval_reference FROM finance_statutory_packages WHERE id=?").get(draft.id);
  assert.equal(String(signed.status), "reviewed");
  assert.equal(String(signed.reviewed_by), CHECKER);
  assert.equal(String(signed.approval_reference), "CA-PKG-2026-08");
});

test("G1 GSTR-9 is prepared from the screen and fails closed until every month is approved", async () => {
  const w = await world();
  const maker = await screen(MAKER);
  await issueInvoiceFromScreen(maker.app);
  await click(maker.app, "Generate statutory package");
  await click(maker.app, "Generate annual return");

  const annual = w.sqlite.prepare("SELECT id,financial_year,status,prepared_by,reconciliation_json FROM finance_annual_returns").get();
  assert.ok(annual, "the annual return an operator could not reach before is now on record");
  assert.equal(String(annual.financial_year), FY);
  assert.equal(String(annual.status), "draft");
  const reconciliation = JSON.parse(String(annual.reconciliation_json));
  assert.equal(reconciliation.reconciled, false);
  assert.equal(reconciliation.monthsMissingApprovedMonthlyReturn.length, 12, "no month is approved yet");

  // The checker tries to sign it off. The twelve-month rule refuses - READABLY, from the screen.
  const { app } = await screen(CHECKER);
  type(app, `Approval reference for ${annual.id}`, "BOARD-2027-04");
  await click(app, "Approve annual return");
  const alerts = panelsWithRole(app.render(), "alert");
  assert.equal(alerts.length, 1);
  assert.match(textOf(alerts[0]), /Every month of the financial year needs an approved monthly statutory package/);
  assert.notEqual(textOf(alerts[0]), "GST/accounting action failed");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM finance_annual_returns WHERE id=?").get(annual.id).status), "draft",
    "and the annual return is still unapproved");
});

test("G1 GSTR-9C, the annual reconciliation statement, is prepared from the screen", async () => {
  const w = await world();
  const { app } = await screen(MAKER);
  await issueInvoiceFromScreen(app);
  await click(app, "Generate GSTR-9C");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0, `${textOf(panelsWithRole(app.render(), "alert")[0])}`);

  const row = w.sqlite.prepare("SELECT return_type,period_code,status,prepared_by,summary_json FROM gst_return_documents WHERE return_type='GSTR-9C'").get();
  assert.ok(row, "GSTR-9C is on record");
  assert.equal(String(row.period_code), FY);
  assert.equal(String(row.prepared_by), MAKER);
  const summary = JSON.parse(String(row.summary_json));
  assert.equal(summary.booksOutputTax, 1_800, "books tax comes from the real invoice, not a placeholder");
  assert.equal(summary.reconciled, false, "no GSTR-9 has been drafted for the year yet, and 9C says so");
  assert.match(String(summary.reconciliation.note), /No GSTR-9 annual return has been drafted/);
});

// =============================================================================================
// G1: document integrity and the close-evidence register
// =============================================================================================

test("G1 an unused invoice serial is voided on the record, and an issued one cannot be", async () => {
  const w = await world();
  const { app } = await screen(MAKER);
  await issueInvoiceFromScreen(app);
  const issued = String(w.sqlite.prepare("SELECT invoice_number FROM finance_invoices").get().invoice_number);

  type(app, "Series GSTIN", GSTIN);
  type(app, "Invoice number to void", issued);
  type(app, "Serial number to void", "1");
  type(app, "Void reason", "Duplicate allocation during the August run");
  await click(app, "Void invoice serial");
  const alerts = panelsWithRole(app.render(), "alert");
  assert.equal(alerts.length, 1, "an ISSUED invoice number must never be voidable");
  assert.equal(textOf(alerts[0]), "That invoice number has already been issued; issue a credit note instead of voiding the serial.");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM finance_document_voids").get().c), 0);

  type(app, "Invoice number to void", "PS/26-27/000009");
  type(app, "Serial number to void", "9");
  await click(app, "Void invoice serial");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0);
  const voided = w.sqlite.prepare("SELECT invoice_number,serial_number,reason,voided_by FROM finance_document_voids").get();
  assert.equal(String(voided.invoice_number), "PS/26-27/000009");
  assert.equal(Number(voided.serial_number), 9);
  assert.equal(String(voided.voided_by), MAKER, "the serial gap is now explained, by name, on the record");
});

test("G1 the FY-aware invoice series, the accounting export and FIN-01 close evidence all post", async () => {
  const w = await world();
  const { app } = await screen(MAKER);

  // The Rule 46(b) series for the financial year.
  type(app, "Series GSTIN", GSTIN);
  type(app, "Series prefix", "PS/26-27/");
  const policySelect = inputLabelled(app.render(), "Series tax policy")[0];
  policySelect.props.onChange({ target: { value: POLICY } });
  app.render();
  await click(app, "Save invoice series");
  assert.equal(panelsWithRole(app.render(), "alert").length, 0, `${textOf(panelsWithRole(app.render(), "alert")[0])}`);
  const series = w.sqlite.prepare("SELECT financial_year,prefix,status FROM finance_document_series_v2 WHERE entity_id=? AND document_type='invoice'").get(ENTITY);
  assert.equal(String(series.financial_year), FY);
  assert.equal(String(series.status), "active");

  // The accounting export, and the acknowledgement that a human received it.
  await click(app, "Generate accounting export");
  const exportRun = w.sqlite.prepare("SELECT id,period_code,target,status,checksum FROM accounting_export_runs").get();
  assert.equal(String(exportRun.period_code), PERIOD);
  assert.equal(String(exportRun.status), "generated");
  assert.ok(String(exportRun.checksum).length === 64, "the export carries a reproducible checksum");

  type(app, `Acknowledgement reference for ${exportRun.id}`, "TALLY-RECEIVED-77");
  await click(app, "Acknowledge export");
  const acknowledged = w.sqlite.prepare("SELECT status,ack_reference FROM accounting_export_runs WHERE id=?").get(exportRun.id);
  assert.equal(String(acknowledged.status), "acknowledged");
  assert.equal(String(acknowledged.ack_reference), "TALLY-RECEIVED-77");

  // FIN-01 close evidence.
  type(app, "Close evidence type", "bank_reconciliation");
  type(app, "Close evidence reference", "HDFC-AUG-2026-STMT");
  type(app, "Close evidence variance", "0");
  type(app, "Close evidence reason", "August bank statement reconciles to the ledger");
  await click(app, "Record close evidence");
  const evidence = w.sqlite.prepare("SELECT period_code,evidence_type,source_reference,status,recorded_by FROM finance_close_evidence").get();
  assert.equal(String(evidence.period_code), PERIOD);
  assert.equal(String(evidence.status), "reconciled");
  assert.equal(String(evidence.recorded_by), MAKER);
});

// =============================================================================================
// Authorization: the screen is gated by the permission the ROUTE requires, and widens nothing
// =============================================================================================

test("a finance.view-only reader sees the registers and is offered no filing control at all", async () => {
  const w = await world();
  const maker = await screen(MAKER);
  await issueInvoiceFromScreen(maker.app);
  await click(maker.app, "Generate GSTR-1");
  const draft = returnRows(w.sqlite)[0];

  const { tree } = await screen(READER);
  assert.match(textOf(tree), /GST, Accounting & Statutory Control/, "the reader can still read the desk");
  assert.match(textOf(sectionUnder(tree, "gst-returns")), /GSTR-1/, "including the return that is waiting");
  for (const control of ["Generate GSTR-1", "Generate GSTR-3B", "Generate GSTR-9C", "Approve return",
    "Generate statutory package", "Generate annual return", "Save invoice series", "Void invoice serial",
    "Issue adjustment note", "Record vendor tax review", "Generate accounting export", "Record close evidence",
    "Issue canonical invoice"]) {
    assert.equal(clickable(tree, control).length, 0, `"${control}" must not be offered without finance.manage`);
  }

  // And the route is the real gate: posting anyway is refused and writes nothing.
  const refused = await post(READER, { action: "approve_gst_return", id: draft.id, approvalReference: "CA-X" });
  assert.equal(refused.status, 403, "finance.view is not finance.manage");
  assert.equal(String(returnRows(w.sqlite)[0].status), "draft");
});

// =============================================================================================
// Triage: every action the route implements is now reachable by a human, and was actually posted
// =============================================================================================

test("every statutory action the route implements was posted by a real control on this screen", async () => {
  // Not a source scan: `postedActions` was filled by the real onClick handlers of the real component
  // in the tests above, through the real fetch, into the real route.
  const implemented = [
    "issue_invoice", "save_statutory_series", "void_invoice_serial", "issue_adjustment", "review_vendor_tax",
    "generate_statutory_package", "approve_statutory_package", "generate_annual_return", "approve_annual_return",
    "generate_accounting_export", "acknowledge_accounting_export", "record_close_evidence",
    "generate_gstr1", "generate_gstr3b", "generate_gstr9c", "approve_gst_return",
  ];
  const missing = implemented.filter((action) => !postedActions.has(action));
  assert.deepEqual(missing, [], `no control on the screen posts: ${missing.join(", ")}`);

  // And a render on its own posts nothing - the controls are controls, not side effects.
  const w = await world();
  const { tree } = await screen(MAKER);
  assert.equal(w.posts.length, 0, "rendering posts nothing");
  assert.ok(clickable(tree, "Generate GSTR-1").length === 1);
});

// =============================================================================================
// Mission 2: GSTR-8 in the statutory calendar
// =============================================================================================

test("GSTR-8 is a tracked monthly obligation due the 10th, and can be marked filed", async () => {
  const compliance = await import("../lib/statutory-compliance.ts");
  const august = compliance.statutoryObligationsFor("2026-08");
  const gstr8 = august.find((item) => item.code === "gstr8");
  assert.ok(gstr8, "the s52 TCS return must appear in the calendar for the month that generated it");
  assert.equal(gstr8.dueDate, "2026-09-10", "s52 GSTR-8 is due the 10th of the following month");
  assert.equal(gstr8.kind, "monthly");
  assert.equal(gstr8.period, "2026-08");
  assert.equal(gstr8.authority, "GST");
  // December rolls the year, and the due date rolls with it.
  assert.equal(compliance.statutoryObligationsFor("2026-12").find((item) => item.code === "gstr8").dueDate, "2027-01-10");
  // It does not disturb the other GST legs.
  const byCode = Object.fromEntries(august.map((item) => [item.code, item.dueDate]));
  assert.equal(byCode.gstr1, "2026-09-11");
  assert.equal(byCode.gstr3b, "2026-09-20");

  const w = await world();
  // The live calendar carries it with a real status...
  const before = await compliance.statutoryCalendar(w.db, "2026-08", Date.UTC(2026, 8, 12));
  const pending = before.find((item) => item.code === "gstr8");
  assert.ok(pending, "the live calendar generates the obligation, not just the pure generator");
  assert.equal(pending.status, "overdue", "on 12 September an unfiled August GSTR-8 is overdue");

  // ...the reminder sweep raises it as a finance alert...
  await compliance.runStatutoryReminderSweep(w.db, { asOf: Date.UTC(2026, 8, 12, 6, 0) });
  const alert = w.sqlite.prepare("SELECT severity,title FROM staff_alerts WHERE idempotency_key='statutory:gstr8:2026-08:overdue'").get();
  assert.ok(alert, "an obligation with no reminder is an obligation nobody files");
  assert.equal(String(alert.severity), "critical");

  // ...and THE OUTCOME: the acknowledgement lands under the key the calendar reads back.
  await compliance.recordStatutoryFiling(w.db, { obligationCode: "gstr8", period: "2026-08", acknowledgementRef: "GSTR8-ACK-2026-08", amount: 45, actorId: MAKER });
  const after = await compliance.statutoryCalendar(w.db, "2026-08", Date.UTC(2026, 8, 12));
  const filed = after.find((item) => item.code === "gstr8");
  assert.equal(filed.status, "filed");
  assert.equal(filed.acknowledgementRef, "GSTR8-ACK-2026-08");
  assert.equal(filed.amount, 45);
  assert.equal(String(w.sqlite.prepare("SELECT due_date FROM statutory_filings WHERE obligation_code='gstr8' AND period='2026-08'").get().due_date), "2026-09-10",
    "the filing row carries the statutory due date, so a late filing is visible afterwards");
});
