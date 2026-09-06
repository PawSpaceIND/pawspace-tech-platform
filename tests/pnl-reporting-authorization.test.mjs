import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// /api/pnl-reporting authorization.
//
// The route served a full profit-and-loss statement — revenue, expense, net —
// through its own local database() helper with no actor resolution at all. It
// imported nothing from lib/server-auth, so it answered any caller, and its
// catch block returned the raw internal error message. Every sibling finance
// surface (gst-accounting, people-finance, partner-finance) authorizes on
// finance.view; this route now does too, and errors go through authError so the
// LEAK-1 redaction applies here as well.
//
// Note on why these tests use a real hostname: isDevelopmentPreview() grants a
// superuser actor with ["*"] permissions whenever NODE_ENV is not "production"
// and the host is localhost / 127.0.0.1 / terminal.local. A test written against
// a local URL would silently bypass authorization entirely and prove nothing.
// That bypass is host-gated, which is asserted below.
// ---------------------------------------------------------------------------

installWorkersHooks("__PNL_DB__", "__PNL_ENV__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const REMOTE = "https://ops.pawspace.example/api/pnl-reporting";
const LOCAL = "http://localhost/api/pnl-reporting";
const NOW = 1770000000000;

const route = await import("../app/api/pnl-reporting/route.ts");
const serverAuth = await import("../lib/server-auth.ts");

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__PNL_DB__ = makeD1(sqlite);
  globalThis.__PNL_ENV__ = {};
  // seeds app_users, role_definitions and the fixed role catalogue
  await serverAuth.ensureSecurityTables(globalThis.__PNL_DB__);
  return { sqlite, db: globalThis.__PNL_DB__ };
}

function rolesByFinanceView(sqlite) {
  const rows = sqlite.prepare("SELECT code,permissions_json FROM role_definitions").all();
  const has = [], lacks = [];
  for (const row of rows) {
    let permissions = [];
    try { permissions = JSON.parse(String(row.permissions_json)); } catch { permissions = []; }
    const grants = permissions.includes("*") || permissions.includes("finance.view") || permissions.includes("finance.*");
    (grants ? has : lacks).push(String(row.code));
  }
  return { has, lacks };
}

function seedUser(sqlite, email, roleCode) {
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(`USR-${email}`, email, email.split("@")[0], roleCode, NOW, NOW);
}
const asUser = (email, url = REMOTE) => new Request(url, { headers: { "oai-authenticated-user-email": email } });

test("the role catalogue actually distinguishes finance.view, so these tests can mean something", async () => {
  const { sqlite } = await world();
  const { has, lacks } = rolesByFinanceView(sqlite);
  assert.ok(has.length > 0, `no role grants finance.view; catalogue: ${JSON.stringify(has.concat(lacks))}`);
  assert.ok(lacks.length > 0, "no role lacks finance.view, so a denial case is not expressible");
});

test("an unauthenticated caller cannot read the P&L statement", async () => {
  await world();
  const response = await route.GET(new Request(REMOTE));
  assert.notEqual(response.status, 200, "an anonymous request must never receive the statement");
  assert.ok([401, 403].includes(response.status), `expected a sign-in or forbidden status, got ${response.status}`);
  const body = JSON.stringify(await response.json());
  for (const leak of ["revenue", "expense", "netProfit", "gross"]) {
    assert.doesNotMatch(body, new RegExp(leak, "i"), `an unauthenticated response must not contain ${leak}`);
  }
});

test("a signed-in identity without finance.view is refused", async () => {
  const { sqlite } = await world();
  const { lacks } = rolesByFinanceView(sqlite);
  seedUser(sqlite, "no.finance@pawspace.in", lacks[0]);
  const response = await route.GET(asUser("no.finance@pawspace.in"));
  assert.equal(response.status, 403, `role ${lacks[0]} must not read the P&L`);
  assert.doesNotMatch(JSON.stringify(await response.json()), /revenue|expense|netProfit/i);
});

test("an identity with finance.view passes authorization", async () => {
  const { sqlite } = await world();
  const { has } = rolesByFinanceView(sqlite);
  seedUser(sqlite, "finance.lead@pawspace.in", has[0]);
  const response = await route.GET(asUser("finance.lead@pawspace.in"));
  assert.ok(![401, 403].includes(response.status), `role ${has[0]} must be allowed through, got ${response.status}`);
});

test("an identity that was never provisioned is refused", async () => {
  await world();
  const response = await route.GET(asUser("stranger@pawspace.in"));
  assert.ok([401, 403].includes(response.status));
  assert.doesNotMatch(JSON.stringify(await response.json()), /revenue|expense|netProfit/i);
});

test("a disabled identity is refused even with a finance role", async () => {
  const { sqlite } = await world();
  const { has } = rolesByFinanceView(sqlite);
  seedUser(sqlite, "former.finance@pawspace.in", has[0]);
  sqlite.prepare("UPDATE app_users SET status='suspended' WHERE email=?").run("former.finance@pawspace.in");
  const response = await route.GET(asUser("former.finance@pawspace.in"));
  assert.equal(response.status, 403);
});

test("month validation still runs, and only after authorization", async () => {
  const { sqlite } = await world();
  const { has } = rolesByFinanceView(sqlite);
  seedUser(sqlite, "finance.lead@pawspace.in", has[0]);
  const bad = await route.GET(new Request(`${REMOTE}?fromMonth=nonsense&toMonth=2026-01`, { headers: { "oai-authenticated-user-email": "finance.lead@pawspace.in" } }));
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(await bad.json()), /YYYY-MM/);
  // the same malformed input from an anonymous caller must be refused, not validated: a 400 here
  // would tell an unauthenticated caller that the endpoint exists and what it accepts.
  const anonymous = await route.GET(new Request(`${REMOTE}?fromMonth=nonsense&toMonth=2026-01`));
  assert.ok([401, 403].includes(anonymous.status), `authorization must precede validation, got ${anonymous.status}`);
});

test("an inverted month range is rejected for an authorized caller", async () => {
  const { sqlite } = await world();
  const { has } = rolesByFinanceView(sqlite);
  seedUser(sqlite, "finance.lead@pawspace.in", has[0]);
  const response = await route.GET(new Request(`${REMOTE}?fromMonth=2026-06&toMonth=2026-01`, { headers: { "oai-authenticated-user-email": "finance.lead@pawspace.in" } }));
  assert.equal(response.status, 400);
});

test("the route no longer answers through its own unauthenticated database helper", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../app/api/pnl-reporting/route.ts", import.meta.url), "utf8");
  assert.match(source, /from"\.\.\/\.\.\/\.\.\/lib\/server-auth"/, "authorization must come from the shared module");
  assert.match(source, /requirePermission\(actor,"finance\.view"\)/);
  assert.doesNotMatch(source, /async function database\(\)/, "a local database() helper is how this route bypassed auth");
  assert.match(source, /authError\(error,"Unable to generate P&L report"\)/, "errors must be redacted, not returned raw");
  assert.doesNotMatch(source, /error instanceof Error\?error\.message/, "the raw internal message must no longer be returned");
});

test("responses are never cached", async () => {
  const { sqlite } = await world();
  const { has } = rolesByFinanceView(sqlite);
  seedUser(sqlite, "finance.lead@pawspace.in", has[0]);
  for (const request of [new Request(REMOTE), asUser("finance.lead@pawspace.in")]) {
    const response = await route.GET(request);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("the development-preview superuser bypass is host-gated", async () => {
  await world();
  const remote = await route.GET(new Request(REMOTE));
  assert.ok([401, 403].includes(remote.status), "a real host must never get the preview superuser");
  const local = await route.GET(new Request(LOCAL));
  assert.ok(![401, 403].includes(local.status), "localhost keeps its documented preview bypass");
});
