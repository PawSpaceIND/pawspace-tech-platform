/*
 * R3-D / F1 + F2 - the statutory desk could not be configured, and a credit note could not be issued.
 *
 * F1 (P1)  On a fresh database a `finance` operator saw "Entities 0", empty pickers, and every statutory
 *          control refused: GSTR-1 400, GSTR-3B 400, GSTR-9C 409 configuration_required, annual return
 *          400, issue invoice 400. The legal entity, the GST registration, the tax policy and the SAC
 *          classification everything fails closed without were creatable ONLY by POSTing
 *          /api/gst-accounting save_entity / approve_entity / save_registration / approve_registration /
 *          save_policy / approve_policy / save_classification by hand - no page posted any of them.
 *
 * F2 (P1)  "Issue adjustment note" refused 409 configuration_required credit_note_series. The operator
 *          set Document type = credit_note and clicked "Save invoice series" on the SAME panel - and got
 *          the identical 409, forever. "Save invoice series" posts save_statutory_series, which writes
 *          finance_document_series_v2; issueAdjustment allocated from the LEGACY finance_document_series.
 *          The only control on the screen wrote a table the feature did not read. The refusal also
 *          reached the alert as the bare token "configuration_required" with no clue WHICH configuration.
 *
 * Nothing here is seeded: the database starts with the security tables and nothing else, and the entire
 * statutory configuration is built by CLICKING the real client component, whose fetch is wired to the
 * REAL route handlers running the REAL engines against a real SQLite-backed D1. The outcome asserted is
 * a fresh installation becoming operable end to end - an invoice issued, a credit note issued, GSTR-1
 * and GSTR-3B prepared - entirely from the product.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__R3D_CFG_DB__");

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
const { ensureSecurityTables } = await import("../lib/server-auth.ts");

const ORIGIN = "https://ops.pawspace.example";
const OPERATOR = "r3d.finance@pawspace.test";
const SECOND = "r3d.finance2@pawspace.test";
const GSTIN = "29AABCP1234A1Z5";
const PERIOD = "2026-08";
const SERIES_FY = "2026-27";

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
function walk(node, visit) {
  if (node == null || typeof node === "boolean") return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (!isElement(node)) return;
  visit(node);
  walk(node.props?.children, visit);
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (key !== "children" && (isElement(value) || Array.isArray(value))) walk(value, visit);
  }
}
function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isElement(node)) return textOf(node.props?.children);
  return "";
}
function findAll(tree, predicate) { const found = []; walk(tree, (node) => { if (predicate(node)) found.push(node); }); return found; }
const clickable = (tree, label) => findAll(tree, (node) => typeof node.props?.onClick === "function" && textOf(node).trim() === label);
const inputLabelled = (tree, label) => findAll(tree, (node) => node.props?.["aria-label"] === label);
const alerts = (tree) => findAll(tree, (node) => node.props?.role === "alert");
const alertText = (app) => alerts(app.render()).map(textOf).join(" | ");
function sectionUnder(tree, testId) {
  const found = findAll(tree, (node) => node.props?.["data-testid"] === testId);
  assert.equal(found.length, 1, `exactly one <section data-testid="${testId}"> must be on screen`);
  return found[0];
}
function type(app, label, value) {
  const fields = inputLabelled(app.render(), label);
  assert.ok(fields.length >= 1, `the screen must carry a "${label}" field`);
  fields[0].props.onChange({ target: { value } });
  return app.render();
}
async function click(app, label, { nth = 0, expect = 1 } = {}) {
  const buttons = clickable(app.render(), label);
  assert.equal(buttons.length, expect, `expected ${expect} "${label}" control(s) on screen, found ${buttons.length}`);
  buttons[nth].props.onClick();
  await app.settle();
  return app.render();
}

// ---------------------------------------------------------------------------------------------
// A world with NO statutory configuration at all - the fresh-install case the audit found.
// ---------------------------------------------------------------------------------------------
let currentActor = OPERATOR;

async function world() {
  const harness = freshCountingD1();
  globalThis.__R3D_CFG_DB__ = harness.db;
  await ensureSecurityTables(harness.db);
  const now = Date.now();
  const insert = harness.sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  insert.run("u-fin", OPERATOR, "Finance operator", "finance", now, now);
  insert.run("u-fin2", SECOND, "Second finance operator", "finance", now, now);
  currentActor = OPERATOR;
  globalThis.fetch = async (url, init) => {
    const absolute = new URL(String(url), ORIGIN);
    const method = (init?.method || "GET").toUpperCase();
    const request = new Request(absolute, {
      method,
      headers: { ...(init?.headers || {}), origin: ORIGIN, "oai-authenticated-user-email": currentActor },
      body: init?.body,
    });
    return method === "POST" ? route.POST(request) : route.GET(request);
  };
  return harness;
}
async function screen(actor) {
  currentActor = actor;
  const app = await mount("../app/team/finance/statutory/page.tsx");
  app.render();
  await app.settle();
  return app;
}
async function post(actor, body) {
  const response = await route.POST(new Request(`${ORIGIN}/api/gst-accounting`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "oai-authenticated-user-email": actor },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

/** Build the whole statutory configuration by clicking, exactly as a new operator must. */
async function configureFromScreen(app) {
  type(app, "Configuration reason", "Initial statutory configuration for the India entity");
  type(app, "Entity legal name", "PawSpace India Pvt Ltd");
  await click(app, "Save legal entity");
  await click(app, "Activate legal entity");

  type(app, "Registration jurisdiction", "KA");
  type(app, "Registration GSTIN", GSTIN);
  type(app, "Registration effective from", "2026-04-01");
  await click(app, "Save GST registration");
  await click(app, "Activate GST registration");

  type(app, "Policy effective from", "2026-04-01");
  await click(app, "Save tax policy");
  const policyId = String(policyRow(app).id);
  type(app, `Policy approval reference for ${policyId}`, "CA-POLICY-2026-01");
  await click(app, "Activate tax policy");

  type(app, "Classification policy", policyId);
  type(app, "Classification service code", "pet_grooming");
  type(app, "Classification SAC/HSN code", "SAC998729");
  type(app, "Classification CGST rate", "9");
  type(app, "Classification SGST rate", "9");
  await click(app, "Save tax classification");
  return policyId;
}
function policyRow(app) {
  const rows = findAll(sectionUnder(app.render(), "statutory-configuration"), (n) => n.type === "code");
  const ids = rows.map((n) => textOf(n)).filter((v) => v.startsWith("taxpol_"));
  assert.ok(ids.length >= 1, "a saved tax policy must be listed on the configuration panel");
  return { id: ids[0] };
}
const one = (sqlite, sql) => sqlite.prepare(sql).get();

// =============================================================================================
// F1 - the configuration surface that did not exist
// =============================================================================================

test("F1 a fresh install refuses everything, and the configuration panel is what unblocks it", async () => {
  const w = await world();

  // The refusals the auditor met, before a single control is touched.
  assert.equal((await post(OPERATOR, { action: "generate_gstr3b", entityId: "", registrationId: "", periodCode: PERIOD })).status, 400);
  const invoiceRefusal = await post(OPERATOR, { action: "issue_invoice", entityId: "", issueDate: `${PERIOD}-05`, sourceEventKey: "x", lines: [] });
  assert.equal(invoiceRefusal.status, 400);

  const app = await screen(OPERATOR);
  const panel = sectionUnder(app.render(), "statutory-configuration");
  assert.ok(textOf(panel).includes("No legal entity yet"), "the empty state must say what is missing, not render an empty table");

  await configureFromScreen(app);
  assert.equal(alerts(app.render()).length, 0, `configuring must succeed: ${alertText(app)}`);

  // THE OUTCOME: the configuration every other control fails closed without is now on record, active.
  const entity = one(w.sqlite, "SELECT id,legal_name,status FROM finance_entities");
  assert.equal(String(entity.legal_name), "PawSpace India Pvt Ltd");
  assert.equal(String(entity.status), "active");
  const registration = one(w.sqlite, "SELECT id,registration_reference,status FROM tax_registrations");
  assert.equal(String(registration.registration_reference), GSTIN);
  assert.equal(String(registration.status), "active");
  const policy = one(w.sqlite, "SELECT id,status,approval_reference FROM tax_policy_versions");
  assert.equal(String(policy.status), "active");
  assert.equal(String(policy.approval_reference), "CA-POLICY-2026-01");
  const classification = one(w.sqlite, "SELECT service_code,tax_component_json FROM tax_classifications");
  assert.equal(String(classification.service_code), "pet_grooming");
  assert.deepEqual(JSON.parse(String(classification.tax_component_json)), [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]);
});

test("F1 after configuring from the screen, the statutory controls that refused now work", async () => {
  const w = await world();
  const app = await screen(OPERATOR);
  await configureFromScreen(app);

  // The invoice series, then a real canonical invoice, then the two monthly returns - all by clicking.
  type(app, "Series prefix", "PS/26-27/");
  type(app, "Series tax policy", String(one(w.sqlite, "SELECT id FROM tax_policy_versions").id));
  await click(app, "Save invoice series");

  type(app, "Return period", PERIOD);
  type(app, "Invoice customer", "CUST-R3D");
  type(app, "Invoice source id", "BKG-R3D");
  type(app, "Invoice issue date", `${PERIOD}-12`);
  type(app, "Invoice service code", "pet_grooming");
  type(app, "Invoice place of supply state", "29");
  type(app, "Invoice taxable amount", "10000");
  type(app, "Invoice reason", "Grooming package for August");
  await click(app, "Issue canonical invoice");
  assert.equal(alerts(app.render()).length, 0, `issuing must succeed: ${alertText(app)}`);

  const invoice = one(w.sqlite, "SELECT invoice_number,subtotal,tax_total FROM finance_invoices");
  assert.ok(invoice, "an invoice can now be issued from a database that had no configuration at all");
  assert.equal(Number(invoice.tax_total), 1800);
  assert.match(String(invoice.invoice_number), /^PS\/26-27\/0000\d\d$/);

  await click(app, "Generate GSTR-1");
  await click(app, "Generate GSTR-3B");
  assert.equal(alerts(app.render()).length, 0, `the returns must generate: ${alertText(app)}`);
  const prepared = w.sqlite.prepare("SELECT return_type FROM gst_return_documents ORDER BY prepared_at").all().map((r) => String(r.return_type));
  assert.deepEqual(prepared, ["GSTR-1", "GSTR-3B"]);
});

test("F1 the configuration panel is gated on finance.manage, like the route", async () => {
  const w = await world();
  const now = Date.now();
  // `admin` carries finance.view but NOT finance.manage - the read-only statutory reviewer.
  w.sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-ro','r3d.readonly@pawspace.test','Read only','admin','active',?,?)").run(now, now);
  const app = await screen("r3d.readonly@pawspace.test");
  assert.equal(findAll(app.render(), (n) => n.props?.["data-testid"] === "statutory-configuration").length, 0,
    "a reviewer without finance.manage is offered no configuration control");
  const refused = await post("r3d.readonly@pawspace.test", { action: "save_entity", legalName: "Sneaky Ltd", countryCode: "IN", reason: "posting around the screen" });
  assert.equal(refused.status, 403, "and the route refuses them too");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM finance_entities").get().n, 0);
});

test("F1 two-person rule: once a second Finance identity exists in the trail, self-activation is refused", async () => {
  const w = await world();
  const app = await screen(OPERATOR);
  await configureFromScreen(app);
  const entityId = String(one(w.sqlite, "SELECT id FROM finance_entities").id);

  // The bootstrap exemption is recorded, not hidden: the sole operator self-approved.
  const bootstrap = w.sqlite.prepare("SELECT after_json FROM gst_accounting_audit_events WHERE entity_type='entity' AND action='approved'").get();
  assert.equal(JSON.parse(String(bootstrap.after_json)).selfApproved, true);

  // A SECOND Finance identity now acts on this desk. From here the exemption no longer applies.
  const second = await post(SECOND, { action: "save_entity", legalName: "PawSpace Logistics Pvt Ltd", countryCode: "IN", reason: "Second legal entity for the logistics arm" });
  assert.equal(second.status, 200);
  const secondEntity = second.body.data.entityId;

  const selfApproval = await post(SECOND, { action: "approve_entity", id: secondEntity, reason: "Activating the entity I just saved" });
  assert.equal(selfApproval.status, 409, "the saver cannot activate their own legal entity once someone else is here");
  assert.match(String(selfApproval.body.error), /Two-person rule/);
  assert.equal(String(w.sqlite.prepare("SELECT status FROM finance_entities WHERE id=?").get(secondEntity).status), "draft", "and nothing moved");

  const countersigned = await post(OPERATOR, { action: "approve_entity", id: secondEntity, reason: "Countersigning the logistics entity" });
  assert.equal(countersigned.status, 200);
  assert.equal(countersigned.body.data.selfApproved, false);
  assert.equal(String(w.sqlite.prepare("SELECT status FROM finance_entities WHERE id=?").get(secondEntity).status), "active");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM finance_entities WHERE id=?").get(entityId).status), "active", "the bootstrap entity is untouched");
});

// =============================================================================================
// F2 - the credit note that could not be issued
// =============================================================================================

async function worldWithInvoice() {
  const w = await world();
  const app = await screen(OPERATOR);
  await configureFromScreen(app);
  type(app, "Series prefix", "PS/26-27/");
  type(app, "Series tax policy", String(one(w.sqlite, "SELECT id FROM tax_policy_versions").id));
  await click(app, "Save invoice series");
  type(app, "Return period", PERIOD);
  type(app, "Invoice customer", "CUST-R3D");
  type(app, "Invoice source id", "BKG-R3D");
  type(app, "Invoice issue date", `${PERIOD}-12`);
  type(app, "Invoice service code", "pet_grooming");
  type(app, "Invoice place of supply state", "29");
  type(app, "Invoice taxable amount", "10000");
  type(app, "Invoice reason", "Grooming package for August");
  await click(app, "Issue canonical invoice");
  assert.equal(alerts(app.render()).length, 0, `issuing must succeed: ${alertText(app)}`);
  // NOTHING has ever written the legacy finance_document_series: the product offers no control that does.
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM finance_document_series").get().n, 0);
  return { w, app };
}

test("F2 the operator saves a credit_note series on the panel that offers it, and the credit note issues", async () => {
  const { w, app } = await worldWithInvoice();
  const invoiceId = String(one(w.sqlite, "SELECT id FROM finance_invoices").id);

  // Exactly the operator's move: Document type = credit_note, Save invoice series, then issue the note.
  type(app, "Document type", "credit_note");
  type(app, "Series prefix", "CN/26-27/");
  await click(app, "Save invoice series");
  assert.equal(alerts(app.render()).length, 0, `saving the series must succeed: ${alertText(app)}`);

  type(app, "Invoice to adjust", invoiceId);
  type(app, "Adjustment taxable amount", "2000");
  type(app, "Adjustment tax amount", "360");
  type(app, "Adjustment reason", "Partial cancellation of the August package");
  await click(app, "Issue adjustment note");

  // THE OUTCOME: the credit note exists, numbered from the series the operator actually configured.
  assert.equal(alerts(app.render()).length, 0, `the credit note must issue: ${alertText(app)}`);
  const note = one(w.sqlite, "SELECT document_number,kind,amount,tax_amount,status FROM finance_adjustment_documents");
  assert.ok(note, "the credit note the product refused to issue is now on record");
  assert.equal(String(note.kind), "credit_note");
  assert.equal(Number(note.tax_amount), 360);
  assert.match(String(note.document_number), /^CN\/26-27\/0000\d\d$/, "numbered from the v2 series the screen wrote, not the legacy table");
  assert.equal(Number(w.sqlite.prepare("SELECT COALESCE(SUM(amount),0) t FROM finance_tax_ledger WHERE ledger_type='adjustment'").get().t), -360);
});

test("F2 an unconfigured series still refuses - and the alert now NAMES the missing configuration", async () => {
  const { w, app } = await worldWithInvoice();
  const invoiceId = String(one(w.sqlite, "SELECT id FROM finance_invoices").id);

  // No credit_note series in EITHER table. The refusal is correct; the message was not.
  type(app, "Invoice to adjust", invoiceId);
  type(app, "Adjustment taxable amount", "2000");
  type(app, "Adjustment tax amount", "360");
  type(app, "Adjustment reason", "Partial cancellation of the August package");
  await click(app, "Issue adjustment note");

  const shown = alertText(app);
  assert.ok(shown, "the refusal must reach the operator");
  assert.match(shown, /credit_note_series/, "the alert must say WHICH configuration is missing");
  assert.notEqual(shown.trim(), "configuration_required", "not the bare token the operator used to get");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM finance_adjustment_documents").get().n, 0);

  // And the route still carries the key it always carried.
  const refused = await post(OPERATOR, { action: "issue_adjustment", invoiceId, kind: "credit_note", amount: 2000, taxAmount: 360, reason: "retry", sourceEventKey: "adj-retry" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "configuration_required");
  assert.equal(refused.body.configurationKey, "credit_note_series");
});

test("F2 an installation configured on the legacy series keeps numbering where it left off", async () => {
  const { w, app } = await worldWithInvoice();
  const invoiceId = String(one(w.sqlite, "SELECT id FROM finance_invoices").id);
  const policyId = String(one(w.sqlite, "SELECT id FROM tax_policy_versions").id);
  const entityId = String(one(w.sqlite, "SELECT id FROM finance_entities").id);
  // A pre-v2 installation: only the legacy row exists, and it is already at serial 41.
  w.sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES ('legacy_cn',?,'credit_note','CN/26-27/',41,6,?,'active',?)").run(entityId, policyId, Date.now());

  type(app, "Invoice to adjust", invoiceId);
  type(app, "Adjustment taxable amount", "1000");
  type(app, "Adjustment tax amount", "180");
  type(app, "Adjustment reason", "Goodwill credit against the August package");
  await click(app, "Issue adjustment note");

  assert.equal(alerts(app.render()).length, 0, `the legacy series must still work: ${alertText(app)}`);
  assert.equal(String(one(w.sqlite, "SELECT document_number FROM finance_adjustment_documents").document_number), "CN/26-27/000041",
    "the migrated v2 series continues the legacy counter instead of restarting at 1");
  const migrated = one(w.sqlite, "SELECT gstin,financial_year,next_number FROM finance_document_series_v2 WHERE document_type='credit_note'");
  assert.equal(String(migrated.gstin), GSTIN, "and it is now FY- and GSTIN-scoped, which the legacy table cannot express");
  assert.equal(String(migrated.financial_year), SERIES_FY);
  assert.equal(Number(migrated.next_number), 42);
});
