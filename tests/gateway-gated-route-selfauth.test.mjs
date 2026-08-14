import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Defense-in-depth: finance-control, pnl-reporting and scheduling-rules previously carried NO auth call
// of their own and relied entirely on the worker gateway. That is fragile (any future path that reaches
// a handler directly is unguarded), and the codebase's own policy is that routes enforce their mapping
// themselves. Each now calls authorize() before doing any work. This proves an unauthenticated caller is
// refused by the HANDLER (non-localhost URL, no identity), independent of the gateway.
// ---------------------------------------------------------------------------
installWorkersHooks("__SELFAUTH_DB__", "__SELFAUTH_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql, []), batch: async (l) => { const o = []; for (const i of l) o.push(await i.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}

function env() {
  const db = makeD1(new DatabaseSync(":memory:"));
  globalThis.__SELFAUTH_DB__ = db;
  globalThis.__SELFAUTH_ENV__ = {};
  return db;
}

const anon = (path, method) => new Request(`https://uat.pawspace.in${path}`, { method, headers: { origin: "https://uat.pawspace.in" }, ...(method === "GET" ? {} : { body: "{}" }) });

const CASES = [
  ["../app/api/finance-control/route.ts", "/api/finance-control", ["GET", "POST", "PATCH"]],
  ["../app/api/pnl-reporting/route.ts", "/api/pnl-reporting", ["GET"]],
  ["../app/api/scheduling-rules/route.ts", "/api/scheduling-rules", ["GET", "POST", "PATCH", "DELETE"]],
];

for (const [mod, path, methods] of CASES) {
  test(`${path} handlers refuse an unauthenticated caller`, async () => {
    const route = await import(mod);
    for (const method of methods) {
      env();
      const res = await route[method](anon(path, method));
      assert.ok(res instanceof Response, `${method} ${path} must return a Response`);
      assert.ok([401, 403].includes(res.status), `${method} ${path} must deny an anonymous caller (401/403), got ${res.status}`);
    }
  });
}
