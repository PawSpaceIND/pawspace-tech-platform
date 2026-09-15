import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// /team/finance-compliance — the month-close and TDS-deposit screen — showed every refusal in the
// SUCCESS panel, and offered a "Record filing" button on TDS-return rows that could never succeed.
//
// P0: act()'s catch wrote to `notice`, rendered as a white <div role="status">. The red
//     <div role="alert"> bound to `error` was never reached from an action. After a rejected TDS
//     filing the only thing on screen was a polite white "quarter (1-4) and form (24Q/26Q) are
//     required" — on a screen where an operator is depositing statutory tax, that reads as done.
// P1: recordFiling() routed any tds_return_* code to action "file_tds_return" while sending only
//     obligationCode/acknowledgementRef/period. The handler requires quarter (1-4) and form
//     (24Q/26Q); Number(undefined) is NaN, so it was a 400 every single time. It also sent the MONTH
//     on screen as the period, while a TDS return's obligation period is an FY quarter label
//     ("FY2026-27-Q2") — the key the calendar reads its "filed" badge back from.
//
// These execute the REAL client component. `node --experimental-strip-types` has no JSX transform, so
// the .tsx goes through tests/helpers/module-hooks.mjs (TypeScript's own compiler, already a
// devDependency) and hooks are driven by installing a dispatcher into React's own hook slot — so
// useState/useEffect/useCallback, the real effect that loads the dashboard, the real onClick handlers
// and the real JSX branches all run. Nothing here reads the source text.
// ---------------------------------------------------------------------------

installWorkersHooks("__FINANCE_COMPLIANCE_UI_DB__");

// The page's UI kit barrel pulls in TrendChart -> recharts -> redux, which cannot be linked by the
// synchronous loader hook, and OpsShell pulls next/navigation, whose CJS entry cannot either. Neither
// is on the path under test (the page's own elements are inspected, never rendered further), so both
// resolve to inert stubs. Directory imports ("../../components/ui") also need index.ts resolution.
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

// --- a minimal React runtime: real component, real hooks, no DOM -------------------------------------

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
    useCallback(fn, deps) {
      const cell = cells[cursor++] ??= {};
      if (changed(cell, deps)) { cell.deps = deps; cell.value = fn; }
      return cell.value;
    },
    useMemo(fn, deps) {
      const cell = cells[cursor++] ??= {};
      if (changed(cell, deps)) { cell.deps = deps; cell.value = fn(); }
      return cell.value;
    },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; },
    useEffect(fn, deps) {
      const cell = cells[cursor++] ??= {};
      if (changed(cell, deps)) { cell.deps = deps; pending.push(fn); }
    },
  };
  dispatcher.useLayoutEffect = dispatcher.useEffect;

  function render() {
    const previous = internals.H;
    cursor = 0;
    internals.H = dispatcher;
    try { return Component(); } finally { internals.H = previous; }
  }
  async function settle() {
    const queued = pending;
    pending = [];
    for (const effect of queued) effect();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { render, settle, state: () => cells.map((cell) => cell.value) };
}

// --- element-tree inspection -------------------------------------------------------------------------

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
  walk(tree, (node, ancestors) => { if (predicate(node, ancestors)) found.push({ node, ancestors }); });
  return found;
}

const panelsWithRole = (tree, role) => findAll(tree, (node) => node.props?.role === role).map(({ node }) => node);
const clickable = (tree, label) => findAll(tree, (node) => typeof node.props?.onClick === "function" && textOf(node).trim() === label);

// --- fixtures ----------------------------------------------------------------------------------------

const PERIOD = "2026-09";
const QUARTER_PERIOD = "FY2026-27-Q2";

const obligation = (over) => ({
  code: "gstr1", label: "GSTR-1", authority: "GST", period: PERIOD, dueDate: "2026-10-11",
  kind: "monthly", notes: "Outward supplies", status: "due_soon", daysToDue: 3,
  acknowledgementRef: null, amount: null, ...over,
});

const DASHBOARD = {
  period: PERIOD,
  calendar: [
    obligation({}),
    obligation({ code: "tds_return_24q", label: "TDS return 24Q (salaries) FY2026-27-Q2", authority: "Income Tax", period: QUARTER_PERIOD, dueDate: "2026-10-31", kind: "quarterly", status: "overdue", daysToDue: -2 }),
  ],
  close: {
    period: PERIOD, status: "open", checklist: [{ key: "gst", label: "GST computed", ok: true, value: 1200, detail: "from invoices" }],
    revenue: { bookings: 100, bookingCount: 2, foodOrders: 0, foodOrderCount: 0, total: 100 },
    gst: { outputTax: 18, eligibleInputTax: 2, netPayable: 16, invoiceCount: 2 },
    tds: { total: 500, sections: {}, deposited: false, depositDueDate: "2026-10-07" },
    payroll: { runStatus: "draft", employees: 3, grossTotal: 9000 },
    boardApproval: { approved: false, approvedBy: null }, closedBy: null, closedAt: null,
  },
  tds: { deductions: [], deposit: null, quarterlyReturns: [{ fy_label: "FY2026-27", quarter: 2, form: "24Q", total_tds: 500, total_deposited: 500, status: "prepared", acknowledgement_ref: null }] },
};

/** Installs window.prompt/confirm and a fetch that serves the dashboard and records every POST. */
function browser({ postResponse }) {
  const posts = [];
  globalThis.window = { prompt: () => "TRACES-ACK-77", confirm: () => true };
  globalThis.fetch = async (url, init) => {
    if (!init || (init.method || "GET") === "GET") {
      return { ok: true, status: 200, json: async () => ({ data: DASHBOARD }) };
    }
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return postResponse();
  };
  return posts;
}

const ok = () => ({ ok: true, status: 201, json: async () => ({ data: { recorded: true } }) });
const refused = (message, status = 400) => () => ({ ok: false, status, json: async () => ({ error: message }) });

async function screen(postResponse) {
  const posts = browser({ postResponse });
  const app = await mount("../app/team/finance-compliance/page.tsx");
  app.render();          // first pass: data is null, the load effect is queued
  await app.settle();    // the effect runs, the dashboard arrives
  return { app, posts, tree: app.render() };
}

// --- P0: a refusal is an alert, never a notice -------------------------------------------------------

test("P0 a refused action renders in the red role=alert panel and nowhere in the notice panel", async () => {
  const message = "quarter (1-4) and form (24Q/26Q) are required";
  const { app, tree } = await screen(refused(message));

  assert.equal(clickable(tree, "Run reminder sweep now").length, 1, "the action under test is on screen");
  clickable(tree, "Run reminder sweep now")[0].node.props.onClick();
  await app.settle();
  const after = app.render();

  const alerts = panelsWithRole(after, "alert");
  const notices = panelsWithRole(after, "status");
  assert.equal(alerts.length, 1, "the refusal must raise exactly one alert panel");
  assert.equal(textOf(alerts[0]), message, "and it must carry the server's own reason");
  assert.match(String(alerts[0].props.className), /panelError/, "the alert panel is the red one");
  assert.equal(notices.length, 0, `a failure must leave the success panel empty, found: ${notices.map(textOf).join(" | ")}`);
});

test("P0 a successful action still renders in the polite role=status panel, with no alert", async () => {
  const { app, tree } = await screen(ok);
  clickable(tree, "Run reminder sweep now")[0].node.props.onClick();
  await app.settle();
  const after = app.render();

  const notices = panelsWithRole(after, "status");
  assert.equal(panelsWithRole(after, "alert").length, 0, "a success must not raise an alert");
  assert.equal(notices.length, 1);
  assert.match(textOf(notices[0]), /Reminder sweep completed/);
});

test("P0 a later failure clears the stale success notice instead of sitting beside it", async () => {
  let response = ok();
  const posts = browser({ postResponse: () => response });
  const app = await mount("../app/team/finance-compliance/page.tsx");
  app.render(); await app.settle();

  clickable(app.render(), "Run reminder sweep now")[0].node.props.onClick();
  await app.settle();
  assert.equal(panelsWithRole(app.render(), "status").length, 1, "the success notice is showing");

  response = { ok: false, status: 409, json: async () => ({ error: "Month 2026-09 is already closed" }) };
  clickable(app.render(), "Run reminder sweep now")[0].node.props.onClick();
  await app.settle();
  const after = app.render();
  assert.equal(panelsWithRole(after, "status").length, 0, "the previous success must not remain on screen beside a failure");
  assert.equal(textOf(panelsWithRole(after, "alert")[0]), "Month 2026-09 is already closed");
  assert.equal(posts.length, 2);
});

// --- P1: the TDS-return row's Record filing button ---------------------------------------------------

test("P1 Record filing on a TDS-return row sends a payload the handler accepts", async () => {
  const { app, posts, tree } = await screen(ok);

  const row = findAll(tree, (node) => String(node.key ?? "").includes("tds_return_24q"));
  assert.equal(row.length, 1, "the TDS-return obligation is on the calendar");
  const buttons = clickable(row[0].node, "Record filing");
  assert.equal(buttons.length, 1, "and it still offers Record filing");

  buttons[0].node.props.onClick();
  await app.settle();

  assert.equal(posts.length, 1);
  const sent = posts[0].body;
  assert.notEqual(sent.action, "file_tds_return",
    "file_tds_return needs quarter and form, which this row never collects — routing here was a guaranteed 400");
  assert.equal(sent.action, "record_filing");
  assert.equal(sent.obligationCode, "tds_return_24q");
  assert.equal(sent.acknowledgementRef, "TRACES-ACK-77");
  assert.equal(sent.period, QUARTER_PERIOD,
    "a quarterly obligation records against its own FY-quarter period, not the month on screen");
});

test("P1 the payload the button sends really is accepted by the live route, and the row flips to filed", async () => {
  const { app, posts, tree } = await screen(ok);
  const row = findAll(tree, (node) => String(node.key ?? "").includes("tds_return_24q"))[0].node;
  clickable(row, "Record filing")[0].node.props.onClick();
  await app.settle();

  // The exact body the screen sends, replayed against the real handler and a real D1.
  const sqlite = new DatabaseSync(":memory:");
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
    run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  const db = { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; } };
  globalThis.__FINANCE_COMPLIANCE_UI_DB__ = db;
  await (await import("../lib/server-auth.ts")).ensureSecurityTables(db);

  const { POST } = await import("../app/api/statutory-compliance/route.ts");
  const response = await POST(new Request("http://localhost:3000/api/statutory-compliance", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(posts[0].body),
  }));
  const payload = await response.json();
  assert.equal(response.status, 201, `the recorded filing must be accepted, got ${response.status} ${JSON.stringify(payload)}`);

  const { statutoryCalendar } = await import("../lib/statutory-compliance.ts");
  const calendar = await statutoryCalendar(db, PERIOD);
  const filed = calendar.find((item) => item.code === "tds_return_24q");
  assert.ok(filed, "the calendar still generates the TDS-return obligation");
  assert.equal(filed.status, "filed", "the acknowledgement lands under the key the calendar reads back");
  assert.equal(filed.acknowledgementRef, "TRACES-ACK-77");
});

test("P1 the TRACES prepare/mark-filed workflow below is untouched and still sends quarter and form", async () => {
  const { app, posts, tree } = await screen(ok);
  clickable(tree, "Mark filed")[0].node.props.onClick();
  await app.settle();
  assert.deepEqual(
    { action: posts[0].body.action, fyLabel: posts[0].body.fyLabel, quarter: posts[0].body.quarter, form: posts[0].body.form },
    { action: "file_tds_return", fyLabel: "FY2026-27", quarter: 2, form: "24Q" },
  );
});
