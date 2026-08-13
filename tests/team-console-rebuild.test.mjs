/**
 * The four team screens that already worked but did not look or read like it: the CX queue, the case
 * center, lifecycle reminders and meet & greet.
 *
 * The substantive defect was on the reminders screen. A sweep that finds nothing new records a
 * suppression, so a list of the hundred most recent events showed a wall of "duplicate prevented" -
 * the de-duplication working read as nothing working. The API now separates the two outcomes over the
 * whole history, which is exercised here against real rows.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";


installWorkersHooks("__CONSOLE_DB__", "__CONSOLE_ENV__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const out = [];
      for (const item of statements) out.push(await item.run());
      return out;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

const PREVIEW = "http://localhost";
const page = (path) => readFile(new URL(`../app/team/${path}`, import.meta.url), "utf8");

test("real execution: the reminders API separates what was queued from what was suppressed", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__CONSOLE_DB__ = makeD1(sqlite);
  globalThis.__CONSOLE_ENV__ = {};
  const route = await import("../app/api/customer-reminders/route.ts");

  // Run once so the module creates its own tables, then seed the two outcomes a sweep produces.
  await route.GET(new Request(`${PREVIEW}/api/customer-reminders`));
  const now = Date.now();
  const insert = sqlite.prepare("INSERT INTO reminder_governance_events (id,customer_id,reminder_type,cycle_key,message_id,duplicate_prevented,created_at) VALUES (?,?,?,?,?,?,?)");
  insert.run("RGE-1", "CUS0001", "grooming_rebooking", "cycle-1", "MSG-1", 0, now - 90 * 60_000);
  insert.run("RGE-2", "CUS0002", "grooming_rebooking", "cycle-1", "MSG-2", 0, now - 80 * 60_000);
  insert.run("RGE-3", "CUS0003", "subscription_sessions", "cycle-1", "MSG-3", 0, now - 70 * 60_000);
  // Every five-minute sweep since then had nothing new to send.
  for (let index = 0; index < 20; index += 1) {
    insert.run(`RGE-D${index}`, `CUS000${index % 3 + 1}`, index % 2 ? "grooming_rebooking" : "subscription_sessions", "cycle-1", null, 1, now - index * 60_000);
  }

  const response = await route.GET(new Request(`${PREVIEW}/api/customer-reminders`));
  assert.equal(response.status, 200);
  const data = (await response.json()).data;

  // Before this, the screen only had recentEvents - and the newest 100 were all suppressions.
  assert.ok(data.recentEvents.length > 0);
  assert.equal(data.recentEvents.slice(0, 20).every((event) => event.duplicate_prevented === 1), true, "the newest events are all suppressions - the staging symptom");

  const totals = Object.fromEntries(data.outcomeTotals.map((row) => [row.reminder_type, row]));
  assert.equal(totals.grooming_rebooking.queued, 2, "the reminders that were actually sent are still counted");
  assert.equal(totals.grooming_rebooking.suppressed, 10);
  assert.equal(totals.subscription_sessions.queued, 1);
  assert.equal(totals.subscription_sessions.suppressed, 10);
  assert.ok(totals.grooming_rebooking.last_at >= now - 90 * 60_000);
  const queued = data.outcomeTotals.reduce((sum, row) => sum + row.queued, 0);
  assert.equal(queued, 3, "a working system reports what it queued, not just what it skipped");
});

test("real execution: outcome totals stay honest on a database that has never run a sweep", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__CONSOLE_DB__ = makeD1(sqlite);
  globalThis.__CONSOLE_ENV__ = {};
  const route = await import("../app/api/customer-reminders/route.ts");

  const response = await route.GET(new Request(`${PREVIEW}/api/customer-reminders`));
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.deepEqual(data.outcomeTotals, [], "no sweep means no totals - not a fabricated zero row");
  assert.deepEqual(data.recentEvents, []);
});

test("the reminders screen shows both outcomes and explains what a suppression means", async () => {
  const source = await page("customer-reminders/page.tsx");
  assert.match(source, /Reminders queued/);
  assert.match(source, /Suppressed as duplicate/);
  assert.match(source, /queued to outbox/);
  assert.match(source, /already reminded this cycle/);
  // The wording an operator reads must say a suppression is the de-duplication working.
  assert.match(source, /A suppression is not a failure/);
  // A sweep that queues nothing says so, rather than reporting three zeroes as if it had worked.
  assert.match(source, /Nothing new was due/);
  // The old screen printed the raw outcome with no counts and no explanation beside it.
  assert.match(source, /Outcomes by reminder type/);
});

test("every rebuilt team screen is built from the design system, not inline styles", async () => {
  const screens = [
    "customer-experience/page.tsx", "cases/page.tsx", "customer-reminders/page.tsx", "meet-and-greet/page.tsx",
    "subscription-plans/page.tsx", "scheduling/page.tsx", "operations/page.tsx", "people/page.tsx", "finance-compliance/page.tsx",
  ];
  for (const screen of screens) {
    const source = await page(screen);
    assert.match(source, /team-console\.module\.css/, `${screen} must use the shared team console shell`);
    assert.match(source, /OpsShell/, `${screen} must render inside the approved Operations shell`);
    assert.doesNotMatch(source, /PageHeader/, `${screen} must not carry a second page header inside the shell`);
    if (!screen.startsWith("operations") && !screen.startsWith("finance-compliance")) assert.match(source, /EmptyState/, `${screen} must render a real empty state`);
    // The bare-prototype markers these screens shipped with.
    assert.doesNotMatch(source, /fontFamily:\s*"(system-ui|Arial)/, `${screen} must not set its own font`);
    assert.doesNotMatch(source, /background:\s*"#f7f4fb"/, `${screen} must not paint its own page background`);
    assert.doesNotMatch(source, /<main style=/, `${screen} must use the shared console shell, not its own <main> styling`);
    // A raw <button> is only allowed for a list row that carries a shell class; every actual control
    // must be the shared Button so focus, sizing and disabled states are the same everywhere.
    for (const tag of source.match(/<button[^>]*>/g) || []) {
      assert.match(tag, /className=\{styles\./, `${screen} has a hand-rolled button: ${tag.slice(0, 80)}`);
    }
    assert.doesNotMatch(source, /<button[^>]*style=\{\{/, `${screen} must not inline-style its buttons`);
  }
});

test("the Operations shell is the approved chrome, responsive and keyboard-navigable", async () => {
  const [shell, shellCss, adminCss, css] = await Promise.all([
    readFile(new URL("../app/components/ops-shell/OpsShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ops-shell/ops-shell.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/admin.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/team/team-console.module.css", import.meta.url), "utf8"),
  ]);
  // The chrome matches the admin surface it was lifted from: same rail width, colour and workspace.
  assert.match(shellCss, /grid-template-columns: 238px 1fr/);
  assert.match(adminCss, /grid-template-columns: 238px 1fr/);
  assert.match(shellCss, /background: #2d0a5d/);
  assert.match(adminCss, /background: #2d0a5d/);
  // The current screen is marked from the route, and the rail is reachable by keyboard.
  assert.match(shell, /usePathname/);
  assert.match(shell, /aria-current/);
  assert.match(shellCss, /\.sidebar nav a:focus-visible/);
  // It collapses to icons, then to a bottom bar, rather than squeezing the workspace.
  assert.match(shellCss, /@media \(max-width: 1050px\)/);
  assert.match(shellCss, /@media \(max-width: 720px\)/);
  // A badge is only rendered when a screen supplies a real count.
  assert.match(shell, /item\.badge \? <b>/);
  assert.match(css, /\.nav a:focus-visible/, "navigation must show a focus ring");
  assert.match(css, /@media \(max-width: 900px\)/, "the split conversation view must collapse on a narrow screen");
  assert.match(css, /overflow-x: auto/, "wide tables scroll inside their own container");
});

test("every rebuilt screen still keeps its governance statement", async () => {
  const cx = await page("customer-experience/page.tsx");
  assert.match(cx, /does not bypass consent, quiet-hour, retry or adapter controls/);
  const cases = await page("cases/page.tsx");
  assert.match(cases, /Production ready: NO/);
  assert.match(cases, /source of money and safety truth/);
  const reminders = await page("customer-reminders/page.tsx");
  assert.match(reminders, /sandboxed until credentials are configured|stays sandboxed until production credentials/);
  const meet = await page("meet-and-greet/page.tsx");
  assert.match(meet, /Cancellations are always free/);
  assert.match(meet, /no live money/);
});

test("real execution: the CX queue opens on a database without the customer module", async () => {
  // Clicking into /team/customer-experience on a fresh deployment answered
  // `D1_ERROR: no such table: canonical_customers` and the whole queue rendered empty behind a red error.
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__CONSOLE_DB__ = makeD1(sqlite);
  globalThis.__CONSOLE_ENV__ = {};
  const governance = await import("../lib/conversation-governance.ts");
  await governance.ensureConversationGovernance(globalThis.__CONSOLE_DB__);

  const now = Date.now();
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,created_at,updated_at) VALUES ('TH-1','cus_1','open',?,?)").run(now, now);

  const threads = await governance.listConversationThreads(globalThis.__CONSOLE_DB__, { status: "open" });
  assert.equal(threads.length, 1, "the thread the platform does have is still listed");
  assert.equal(threads[0].id, "TH-1");
  assert.equal(threads[0].customer_name, "Customer", "the missing name degrades to a placeholder, not an error");

  // With the customer module present, the real name comes through.
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'seed',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('cus_1','blr','Meera Iyer','9876543210',?,?)").run(now, now);
  const named = await governance.listConversationThreads(globalThis.__CONSOLE_DB__, { status: "open" });
  assert.equal(named[0].customer_name, "Meera Iyer");
  assert.equal(named[0].primary_phone, "9876543210");
});
