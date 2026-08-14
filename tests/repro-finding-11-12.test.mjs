import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// The GET handler in app/api/service-zone/route.ts imports "cloudflare:workers" and reads env.DB.
// Install the resolver so that import resolves to a shim reading globalThis.__ZONE_DB.
installWorkersHooks("__ZONE_DB");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Minimal D1 shim over node:sqlite (same shape as other execution suites).
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

// ---------------------------------------------------------------------------
// FINDING 11 (P2 SECURITY / DATA INTEGRITY):
// A PUBLIC, unauthenticated GET mutates the DB. /api/service-zone is in the
// gateway's null (public) list, yet GET ...?action=seed calls seedDefaultZones(db)
// which INSERTs zone mappings. A public GET must never be a write mechanism.
// ---------------------------------------------------------------------------

test("Finding 11a: /api/service-zone is declared PUBLIC (returns null permission) at the gateway", () => {
  const gw = read("lib/api-gateway.ts");
  // The public null-list: any of these pathnames => `return null` (no permission required).
  const match = /if\(url\.pathname==="\/api\/pricing-quote"[\s\S]*?\)return null;/.exec(gw);
  assert.ok(match, "could not locate the gateway public null-list");
  assert.match(match[0], /url\.pathname==="\/api\/service-zone"/,
    "/api/service-zone must be in the public null-list for this finding to hold");
  console.log("Finding 11a: /api/service-zone IS in the gateway public null-list (requiredPermission => null).");
});

test("Finding 11b: GET action=seed routes to seedDefaultZones, which INSERTs rows", () => {
  const route = read("app/api/service-zone/route.ts");
  assert.match(route, /if\(action==="seed"\)\{\s*await seedDefaultZones\(db\)/,
    "GET handler must call seedDefaultZones on action=seed");
  const zones = read("lib/service-zones.ts");
  assert.match(zones, /export async function seedDefaultZones/, "seedDefaultZones must exist");
  assert.match(zones, /INSERT INTO service_zone_mappings/, "seedDefaultZones must INSERT into service_zone_mappings");
  console.log("Finding 11b: GET ?action=seed -> seedDefaultZones(db) -> INSERT INTO service_zone_mappings.");
});

test("Finding 11c: EXECUTION — public GET ?action=seed writes rows (0 -> N) to an EMPTY DB", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__ZONE_DB = db; // env.DB for the route handler

  const { GET } = await import("../app/api/service-zone/route.ts");

  // Create the table (route/lib does this via ensureServiceZonesTables). Prove it starts EMPTY.
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS service_zone_mappings (pincode TEXT PRIMARY KEY, zone_id TEXT NOT NULL, city TEXT NOT NULL, area TEXT NOT NULL, created_at INTEGER NOT NULL)"),
  ]);
  const before = sqlite.prepare("SELECT COUNT(*) AS n FROM service_zone_mappings").get().n;
  assert.equal(before, 0, "precondition: the service-zone table must start empty");

  // A PUBLIC, UNAUTHENTICATED GET request — no auth headers whatsoever.
  const res = await GET(new Request("https://pawspace.example/api/service-zone?action=seed", { method: "GET" }));
  assert.equal(res.status, 200, "the public GET seed succeeds");
  const body = await res.json();

  const after = sqlite.prepare("SELECT COUNT(*) AS n FROM service_zone_mappings").get().n;
  console.log(`Finding 11c: public GET ?action=seed response = ${JSON.stringify(body)}`);
  console.log(`Finding 11c: service_zone_mappings row count ${before} -> ${after} (rows INSERTED by an unauthenticated GET).`);
  assert.ok(after > 0, "a public unauthenticated GET INSERTED rows — DB mutation via public GET REPRODUCED");
  assert.ok(after >= 60, `expected the full default zone table to be seeded, got ${after}`);
});

// ---------------------------------------------------------------------------
// FINDING 12 (P2): Provider onboarding surfaces RAW API error bodies to users.
// In app/partner/onboarding/page.tsx, both the refresh path and the submit path
// throw `new Error(await r.text())` on non-OK responses, and that message is set
// into the `error` state and rendered verbatim. A raw ownership/auth JSON body
// (e.g. {"error":"Authentication required"} / {"error":"Permission denied"})
// reaches the UI unmodified instead of a controlled user message.
// ---------------------------------------------------------------------------

test("Finding 12: refresh AND submit paths throw new Error(await r.text()) — raw body reaches UI", () => {
  const ui = read("app/partner/onboarding/page.tsx");
  const lines = ui.split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    if (/throw new Error\(await r\.text\(\)\)/.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  for (const h of hits) console.log(`Finding 12: app/partner/onboarding/page.tsx:${h.line}  ${h.text}`);

  // refresh() surfaces raw text on non-OK.
  assert.match(ui, /function refresh\(\)\s*\{[\s\S]*?if \(!r\.ok\) throw new Error\(await r\.text\(\)\)/,
    "refresh() must throw the raw response text on non-OK");
  // post() (submit path) surfaces raw text on non-OK.
  assert.match(ui, /async function post\([\s\S]*?if \(!r\.ok\) throw new Error\(await r\.text\(\)\)/,
    "post()/submit must throw the raw response text on non-OK");
  // The thrown message is written into the error state and rendered verbatim.
  assert.match(ui, /setError\(String\(\(e as Error\)\?\.message \|\| e\)\)/,
    "the raw thrown message is set into the visible error state");
  assert.match(ui, /error \? <p className=\{styles\.errorBox\} role="alert">\{error\}<\/p>/,
    "the error state is rendered verbatim in the UI");

  // At least two raw-body throws (refresh initial-load + submit; plus refresh()).
  assert.ok(hits.length >= 2, `expected >=2 raw \`await r.text()\` throws, found ${hits.length}`);
  console.log(`Finding 12: ${hits.length} raw \`throw new Error(await r.text())\` sites; message flows to <p role="alert">{error}</p>.`);
});

test("Finding 12: example raw body an auth/ownership failure would return (shown verbatim)", () => {
  const gw = read("lib/api-gateway.ts");
  // These are the exact raw JSON bodies the gateway returns for the self-service endpoint
  // when the caller is unauthenticated / unauthorized. `throw new Error(await r.text())`
  // would render the whole JSON string as the user-facing error.
  assert.match(gw, /Response\.json\(\{error:"Authentication required"\},\{status:401\}\)/);
  assert.match(gw, /Response\.json\(\{error:"Permission denied"\},\{status:403\}\)/);
  console.log('Finding 12: raw 401 body shown to provider = {"error":"Authentication required"}');
  console.log('Finding 12: raw 403 body shown to provider = {"error":"Permission denied"}');
});
