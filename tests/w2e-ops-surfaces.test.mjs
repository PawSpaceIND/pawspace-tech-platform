/*
 * The three Operations screens nothing linked to, and the Control Center copy that describes them.
 *
 * Every test here EXECUTES: the real page component runs through the shared client runtime (effects,
 * state, clicks), its fetch goes to the REAL route handler, and that handler reads a real D1 built
 * from the CANONICAL CREATE TABLE of whichever module owns each table. Nothing is asserted by
 * reading source text, because the defects below all passed a source read:
 *
 *   /team/operations/work-queue      the footer advertised seven detectors and told the operator
 *                                    "cron wiring pending (backgroundSchedulerConfigured:false)".
 *                                    There are eight detectors - the missing one is refund_failed,
 *                                    money a gateway refused to return - and worker/index.ts has
 *                                    been sweeping this queue on the five-minute cron for longer
 *                                    than that sentence has been on the screen. No control in the
 *                                    whole app posted `sweep`, which the API has always implemented.
 *
 *   /team/operations/food/supply-chain
 *                                    rendered a "SKUs below reorder" counter and a "Reorder
 *                                    suggested" section computed from food_reorder_policies, a
 *                                    table written ONLY by set_reorder_policy - an action no screen
 *                                    posted. The counter could not leave 0 whatever the stock did.
 *                                    save_kitchen was unposted the same way, so the Kitchen column
 *                                    in the batch table read "—" on every row the platform could
 *                                    produce.
 *
 *   /control                         the hero said "unavailable sources display as not connected"
 *                                    as a rule for the whole console. Seven of its views now answer
 *                                    with five distinguishable readings and never print that phrase.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeModule from "node:module";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { mount, find, all, button, textOf, screenText } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__W2E_OPS_DB__");
/* Two gaps the shared harness leaves, both about the UI kit and neither about the code under test:
 * `../../components/ui` is a DIRECTORY (index.ts), which Node's ESM resolver does not fold in, and
 * that barrel pulls recharts, whose CJS/redux chain cannot be linked from a synchronous hook. */
const RECHARTS_STUB = `data:text/javascript,${encodeURIComponent(
  ["ResponsiveContainer", "LineChart", "Line", "BarChart", "Bar", "AreaChart", "Area", "PieChart", "Pie", "Cell", "XAxis", "YAxis", "CartesianGrid", "Tooltip", "Legend"]
    .map((name) => `export const ${name}=()=>null;`).join(""),
)}`;
const NAVIGATION_STUB = `data:text/javascript,${encodeURIComponent(
  "export const useRouter=()=>({push(){},replace(){},refresh(){},back(){},prefetch(){}});"
  + "export const usePathname=()=>\"/\";export const useSearchParams=()=>new URLSearchParams();"
  + "export const useParams=()=>({});export const redirect=(to)=>{const e=new Error(`NEXT_REDIRECT:${to}`);e.digest=`NEXT_REDIRECT;replace;${to};307;`;throw e;};"
  + "export const permanentRedirect=redirect;export const notFound=()=>{throw new Error(\"NEXT_NOT_FOUND\");};",
)}`;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "recharts") return { url: RECHARTS_STUB, shortCircuit: true };
    if (specifier === "next/navigation") return { url: NAVIGATION_STUB, shortCircuit: true };
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        for (const candidate of [`${specifier}/index.ts`, `${specifier}/index.tsx`]) {
          try { return nextResolve(candidate, context); } catch { /* try the next candidate */ }
        }
      }
      throw error;
    }
  },
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- canonical schemas ---------------------------------------------------------------------------
/* Copied from the owning module at run time, never hand-written: a fixture written by hand proves
 * the query works against the fixture, which is not the claim under test. The canonical booking
 * tables live under app/api, so app/ is walked as well as lib/ and drizzle/. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".wrangler"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|sql)$/.test(entry.name)) out.push(path);
  }
  return out;
}
const SCHEMAS = (() => {
  const found = new Map();
  for (const file of [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "drizzle")), ...walk(join(ROOT, "app"))]) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? ([a-z_]+) \(/gi)) {
      let i = match.index + match[0].length, depth = 1, body = "";
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (!depth) break; }
        body += ch; i++;
      }
      const prior = found.get(match[1]);
      if (!prior || prior.length < body.length) found.set(match[1], body);
    }
  }
  return found;
})();
/* Fill every NOT NULL / key column the canonical schema declares, rather than a hand-written list
 * that goes quietly narrower than the schema the moment that table gains a column. */
function insertRow(sqlite, table, overrides = {}) {
  const info = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  const needed = info.filter((c) => Number(c.notnull) === 1 || Number(c.pk) > 0 || c.name in overrides);
  const names = needed.map((c) => c.name);
  sqlite.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...needed.map((c) => (c.name in overrides ? overrides[c.name]
      : /INT|REAL|NUM|DOUB|FLOA/i.test(String(c.type)) ? 1 : `${table}-${c.name}`)));
}
function createCanonical(sqlite, ...tables) {
  for (const table of tables) {
    const body = SCHEMAS.get(table);
    assert.ok(body, `no canonical CREATE TABLE found for ${table} - this fixture would prove nothing`);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${table} (${body})`);
  }
}

// --- real routes, reached the way the page reaches them ------------------------------------------
const ROUTES = {
  "/api/ops-work-queue": await import("../app/api/ops-work-queue/route.ts"),
  "/api/food-supply-chain": await import("../app/api/food-supply-chain/route.ts"),
  "/api/control-center-operations": await import("../app/api/control-center-operations/route.ts"),
  "/api/control-tower": await import("../app/api/control-tower/route.ts"),
};
/* These screens load through effects, so an assertion is only meaningful once every request the
 * render started has come back. Counting them here makes "settled" a fact rather than a sleep -
 * a fixed number of drain rounds passed and failed on the same code depending on the machine. */
let requestsStarted = 0, requestsFinished = 0;
/** Install a fetch that dispatches the page's own relative URLs into the real route handlers. */
function installFetch() {
  requestsStarted = 0; requestsFinished = 0;
  globalThis.fetch = (input, init = {}) => {
    const raw = typeof input === "string" ? input : String(input.url ?? input);
    const url = new URL(raw, "http://localhost");
    requestsStarted += 1;
    const answer = (async () => {
      if (url.pathname === "/api/team-overview") return Response.json({ data: { actor: { permissions: ["*"] } } });
      const route = ROUTES[url.pathname];
      if (!route) throw new Error(`no route registered for ${url.pathname}`);
      const request = new Request(url.href, init);
      return init.method === "POST" ? route.POST(request) : route.GET(request);
    })();
    answer.then(() => { requestsFinished += 1; }, () => { requestsFinished += 1; });
    return answer;
  };
}

const world = (...tables) => {
  const w = freshCountingD1();
  if (tables.length) createCanonical(w.sqlite, ...tables);
  enterWorkersDbScope(w.db);
  installFetch();
  return w;
};
/* screenText leaves &lt;/&gt; encoded, and these screens print real inequalities ("30 available < 50"). */
const plain = (html) => screenText(html).replace(/&lt;/g, "<").replace(/&gt;/g, ">");
/* settle() returns as soon as nothing is dirty, which can be while a fetch this render started is
 * still in flight. Drain repeatedly so an assertion reads the settled screen, not the spinner. */
const settled = async (ui) => {
  for (let i = 0; i < 40; i += 1) {
    await ui.settle();
    if (requestsStarted > 0 && requestsStarted === requestsFinished) {
      await ui.settle();
      if (requestsStarted === requestsFinished) return plain(ui.html());
    }
  }
  throw new Error(`screen never settled: ${requestsFinished}/${requestsStarted} requests came back`);
};
const click = async (ui, label) => { await button(ui.tree(), label).props.onClick(); await settled(ui); };
const type = (node, value) => node.props.onChange({ target: { value } });
const inputIn = (scope, placeholder) => {
  const node = find(scope, (n) => n.type === "input" && n.props?.placeholder === placeholder);
  assert.ok(node, `an input placeholdered "${placeholder}" is on screen`);
  return node;
};
const articleNamed = (tree, heading) => {
  const node = find(tree, (n) => n.type === "article" && find(n, (c) => c.type === "h2" && textOf(c) === heading));
  assert.ok(node, `a card headed "${heading}" is on screen`);
  return node;
};

// =================================================================================================
// 1. The exception work queue
// =================================================================================================

const WORK_QUEUE_SOURCES = ["canonical_bookings", "provider_work_orders", "payment_reconciliation_exceptions"];

test("W2E-1: EXECUTED - an operator can turn a real exception into a visible task from the screen itself", async () => {
  const { sqlite } = world(...WORK_QUEUE_SOURCES);
  /* A refund the gateway REJECTED: the detector that no advertised list mentioned. */
  sqlite.prepare("INSERT INTO payment_reconciliation_exceptions (id,booking_id,payment_id,exception_type,severity,status,detail_json,created_at) VALUES ('PX-FAILED','BK-77','PAY-77','refund_failed','critical','open','{}',?)").run(Date.now());

  const page = await import("../app/team/operations/work-queue/page.tsx");
  const ui = mount(page.default, {}, { label: "work queue" });
  await settled(ui);

  /* Before: the condition is real and sitting in the database, and the screen shows nothing to do.
   * That is the state an operator actually met, because the only thing that turns a condition into
   * a task is a sweep and nothing on any screen could ask for one. */
  assert.match(plain(ui.html()), /No open tasks in this queue/, "the queue starts empty");

  await click(ui, "Sweep now");

  const after = plain(ui.html());
  assert.match(after, /Refund FAILED at the gateway on booking BK-77/,
    `the exception must become a task the operator can see and act on. Screen: ${after.slice(0, 400)}`);
  assert.match(after, /customer is still owed this money/);
  assert.match(after, /Sweep complete · 1 new task/, "the control must report what it did");
  /* The outcome, not the ingredient: the task is selectable and its actions are on screen. */
  assert.ok(find(ui.tree(), (n) => n.type === "button" && textOf(n) === "Resolve"), "the new task is actionable");
});

test("W2E-2: EXECUTED - sweeping twice creates the task once, so the control is safe to press", async () => {
  const { sqlite } = world(...WORK_QUEUE_SOURCES);
  sqlite.prepare("INSERT INTO payment_reconciliation_exceptions (id,booking_id,payment_id,exception_type,severity,status,detail_json,created_at) VALUES ('PX-1','BK-1','PAY-1','capture_amount_mismatch','critical','open','{}',?)").run(Date.now());

  const page = await import("../app/team/operations/work-queue/page.tsx");
  const ui = mount(page.default, {}, { label: "work queue" });
  await settled(ui);
  await click(ui, "Sweep now");
  assert.match(plain(ui.html()), /Sweep complete · 1 new task/);
  await click(ui, "Sweep now");
  assert.match(plain(ui.html()), /Sweep complete · 0 new task/, "a second sweep must not duplicate the work item");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM ops_work_queue_tasks").get().c, 1);
});

test("W2E-3: EXECUTED - the footer names every detector that runs, and does not deny the cron that runs them", async () => {
  world(...WORK_QUEUE_SOURCES);
  const page = await import("../app/team/operations/work-queue/page.tsx");
  const ui = mount(page.default, {}, { label: "work queue" });
  const text = await settled(ui);

  /* Every rule the sweep can actually raise, read from the module that raises them - so adding a
   * ninth detector without telling the operator fails here rather than being noticed years later. */
  const { WORK_QUEUE_DETECTORS } = await import("../lib/ops-work-queue.ts");
  assert.ok(WORK_QUEUE_DETECTORS.includes("refund_failed"), "refund_failed is one of the rules the sweep raises");
  for (const rule of WORK_QUEUE_DETECTORS) {
    const pretty = rule.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
    assert.ok(text.includes(pretty), `the footer must name the ${rule} detector. It said: ${text.slice(-400)}`);
  }
  assert.match(text, new RegExp(`Detectors \\(${WORK_QUEUE_DETECTORS.length}\\)`));

  assert.doesNotMatch(text, /cron wiring pending/i,
    "worker/index.ts scheduled() runs runBackgroundScheduler, which sweeps this queue, on the cron in wrangler.toml");
  assert.doesNotMatch(text, /backgroundSchedulerConfigured:false/);
  assert.match(text, /worker\.scheduled/,
    "name the runner, so the claim can be checked against wrangler.toml");
  assert.doesNotMatch(text, /Swept automatically by worker\.scheduled on \*\/5 \* \* \* \*/,
    "an unconditional 'it is swept automatically' is a compile-time claim, and it was wrong here: " +
    "the footer must report whether a run has ACTUALLY been recorded (R3-F F-P2b)");
});

// =================================================================================================
// 2. The Food supply chain
// =================================================================================================

test("W2E-4: EXECUTED - reorder governance is reachable: the threshold can be set and the counter then moves", async () => {
  world();
  const page = await import("../app/team/operations/food/supply-chain/page.tsx");
  const ui = mount(page.default, {}, { label: "supply chain" });
  await settled(ui);

  /* The seeded UAT inventory holds 30 units of this SKU in this zone. With no policy row there is no
   * threshold, so the screen's own counter cannot leave zero however low the stock goes. */
  const sku = "food-uat-dog-adult-2kg", zone = "blr-east";
  const before = plain(ui.html());
  assert.match(before, /SKUs below reorder/);
  assert.doesNotMatch(before, /Reorder suggested/, "nothing can be suggested before a threshold exists");
  assert.match(before, /No reorder thresholds are set/, "and the screen must say that rather than imply healthy stock");

  const card = articleNamed(ui.tree(), "Reorder policy");
  type(inputIn(card, "SKU"), sku);
  type(inputIn(card, "Zone"), zone);
  type(inputIn(card, "Minimum available units"), "50");
  type(inputIn(card, "Reorder quantity"), "25");
  await ui.settle();
  await click(ui, "Save reorder policy");

  const after = plain(ui.html());
  assert.match(after, /Reorder suggested/, `the governed suggestion must now render. Screen: ${after.slice(0, 500)}`);
  assert.match(after, new RegExp(`${sku} in ${zone}: 30 available < minimum 50 → order 25 units`));
  assert.match(after, /never auto-purchased/, "it stays a suggestion, not a purchase");

  /* The counter the screen has always rendered is finally computable. */
  const statLabels = all(ui.tree(), (n) => typeof n.type === "function" && n.props?.label === "SKUs below reorder");
  assert.equal(statLabels.length, 1);
  assert.equal(statLabels[0].props.value, 1, "the metric that could only ever read 0 now reads what is true");
});

test("W2E-5: EXECUTED - a kitchen can be registered and a received batch is attributed to it", async () => {
  world();
  const page = await import("../app/team/operations/food/supply-chain/page.tsx");
  const ui = mount(page.default, {}, { label: "supply chain" });
  await settled(ui);
  assert.doesNotMatch(plain(ui.html()), /Central Kitchen/);

  const kitchen = articleNamed(ui.tree(), "Kitchen");
  type(inputIn(kitchen, "Kitchen name"), "Central Kitchen");
  type(inputIn(kitchen, "Delivery zone"), "blr-east");
  await ui.settle();
  await click(ui, "Save kitchen");
  assert.match(plain(ui.html()), /Central Kitchen · blr-east · Active/, "the kitchen is on screen and usable");

  const supplier = articleNamed(ui.tree(), "Supplier");
  type(inputIn(supplier, "Supplier name"), "Fresh Foods Pvt Ltd");
  type(inputIn(supplier, "Contact phone"), "+919000000001");
  await ui.settle();
  await click(ui, "Save supplier");

  const supplierId = String(find(ui.tree(), (n) => n.type === "code" && String(textOf(n)).startsWith("FSUP"))?.props.children);
  assert.match(supplierId, /^FSUP-/);
  const kitchenId = String(find(ui.tree(), (n) => n.type === "code" && String(textOf(n)).startsWith("FKIT"))?.props.children);
  assert.match(kitchenId, /^FKIT-/);

  const po = articleNamed(ui.tree(), "Purchase order");
  type(inputIn(po, "Supplier ID"), supplierId);
  type(inputIn(po, "SKU"), "food-uat-dog-adult-2kg");
  type(inputIn(po, "Zone"), "blr-east");
  type(inputIn(po, "Quantity"), "40");
  type(inputIn(po, "Unit cost"), "120");
  const select = find(po, (n) => n.type === "select");
  assert.ok(select, "the purchase order must be able to name a kitchen");
  select.props.onChange({ target: { value: kitchenId } });
  await ui.settle();
  await click(ui, "Create PO");

  const poId = String(find(ui.tree(), (n) => n.type === "code" && String(textOf(n)).startsWith("FPO"))?.props.children || "");
  const receive = articleNamed(ui.tree(), "Receive → batch");
  type(inputIn(receive, "Purchase order ID"), poId || (await (async () => {
    const r = await fetch("/api/food-supply-chain");
    return String((await r.json()).data.purchaseOrders[0].id);
  })()));
  const dates = all(receive, (n) => n.type === "input" && n.props?.type === "date");
  type(dates[0], "2026-09-15");
  type(dates[1], "2026-09-30");
  await ui.settle();
  await click(ui, "Receive");

  const after = plain(ui.html());
  assert.match(after, new RegExp(kitchenId), `the received batch must carry the kitchen it went to. Screen: ${after.slice(-700)}`);
  assert.match(after, /2026-09-30/, "and its expiry date");
});

// =================================================================================================
// 3. The Control Center's copy about all of this
// =================================================================================================

test("W2E-6: EXECUTED - the shipping governance panel gives each of the five readings its own sentence", async () => {
  const panelModule = await import("../app/control/live-governance-panel.tsx");
  const worlds = {
    /* master issues no evidence query at all */
    not_queried: { mode: "master", tables: ["city_launch_configs"] },
    /* unified_cases is not on this database */
    uninitialised: { mode: "quality", tables: [] },
    /* it is there and is missing the columns both queries name */
    unreadable: { mode: "quality", tables: [], drift: "CREATE TABLE unified_cases (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)" },
    /* the query ran against a real table and found nothing */
    empty: { mode: "security", tables: ["security_audit_events"] },
    /* and rows, when there are rows */
    rows: { mode: "security", tables: ["security_audit_events"], seed: { table: "security_audit_events", row: { actor_email: "founder@pawspace.in", action: "control.view", outcome: "allowed" } } },
  };
  const rendered = {};
  for (const [state, spec] of Object.entries(worlds)) {
    const w = world(...spec.tables);
    if (spec.drift) w.sqlite.exec(spec.drift);
    if (spec.seed) insertRow(w.sqlite, spec.seed.table, spec.seed.row);
    const ui = mount(panelModule.default, { mode: spec.mode }, { label: `panel:${state}` });
    rendered[state] = await settled(ui);
  }
  assert.match(rendered.not_queried, /NO EVIDENCE QUERY IN THIS VIEW/);
  assert.match(rendered.uninitialised, /SOURCE NOT INITIALISED · NOT QUERIED/);
  assert.match(rendered.unreadable, /EVIDENCE QUERY FAILED · SCHEMA MISMATCH/);
  assert.match(rendered.empty, /QUERIED · NO ROWS/);
  assert.match(rendered.rows, /founder@pawspace\.in/);
  for (const [state, text] of Object.entries(rendered)) {
    assert.doesNotMatch(text, /no recent records in this source/i, `${state} rendered the sentence this vocabulary exists to delete`);
    assert.doesNotMatch(text, /not connected/i, `${state} rendered "not connected", a warm-up artifact stated as a fact about the platform`);
  }
  /* Five readings, five sentences - asserted on the panel a founder actually loads, not on the
   * exported pieces. Reverting the default component to its own fallback leaves the exported
   * MetricCard/EvidenceBody correct and turns this red anyway. */
  const evidenceLines = Object.values(rendered).map((text) => text.replace(/^.*?Evidence /s, ""));
  assert.equal(new Set(evidenceLines).size, 5, `each reading must read differently:\n${JSON.stringify(evidenceLines, null, 2)}`);
});

test("W2E-7: EXECUTED - the /control hero describes the readings this console actually shows", async () => {
  world();
  const controlPage = await import("../app/control/page.tsx");
  const ui = mount(controlPage.default, {}, { label: "control", passes: 60 });
  const text = await settled(ui);

  /* The hero used to state a two-word vocabulary as a rule for the whole console. It is a rule for
   * the coverage bars only, and the sentence must say so - checked against what those bars, fed by
   * the real /api/control-tower on a cold database, actually print. */
  assert.match(text, /coverage bars below, unavailable sources display as not connected/i);
  assert.doesNotMatch(text, /governance table; unavailable sources display as not connected/i,
    "the unscoped claim covered seven views that never print that phrase");
  assert.match(text, /not connected/, "the bars really do print it, so the scoped sentence is checkable");

  /* And it must name the readings those seven views answer with instead. */
  for (const reading of ["queried and empty", "not created on this database yet", "schema mismatch", "no evidence query in that view"]) {
    assert.ok(text.includes(reading), `the hero must name the "${reading}" reading. Hero: ${text.slice(0, 900)}`);
  }
  assert.match(text, /five readings/i);
});
