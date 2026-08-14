/**
 * REGRESSION for FINDING 11 (P2 SECURITY / DATA INTEGRITY):
 * /api/service-zone is public and unauthenticated (gateway null-list). Its GET handler must be
 * READ-ONLY. The former GET ?action=seed path called seedDefaultZones(db) and INSERTed the full
 * default zone table on a plain, unauthenticated URL. This suite proves that after the fix:
 *   - an unauthenticated GET ?action=seed inserts NO rows (count stays 0) and does not succeed, and
 *   - the legitimate read actions (list / resolve-by-pincode) still work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__ZONE_DB");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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

test("source: the GET handler no longer calls seedDefaultZones (no write on any GET path)", () => {
  const route = read("app/api/service-zone/route.ts");
  assert.equal(/seedDefaultZones\s*\(/.test(route), false, "GET handler must not invoke seedDefaultZones");
  assert.equal(/await seedDefaultZones/.test(route), false, "no seed mutation may remain on the GET path");
});

test("EXECUTION: unauthenticated GET ?action=seed inserts NO rows (count stays 0) and does not 200", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__ZONE_DB = db;

  const { GET } = await import("../app/api/service-zone/route.ts");

  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS service_zone_mappings (pincode TEXT PRIMARY KEY, zone_id TEXT NOT NULL, city TEXT NOT NULL, area TEXT NOT NULL, created_at INTEGER NOT NULL)"),
  ]);
  const before = sqlite.prepare("SELECT COUNT(*) AS n FROM service_zone_mappings").get().n;
  assert.equal(before, 0, "precondition: table starts empty");

  const res = await GET(new Request("https://pawspace.example/api/service-zone?action=seed", { method: "GET" }));
  const body = await res.json();

  const after = sqlite.prepare("SELECT COUNT(*) AS n FROM service_zone_mappings").get().n;
  console.log(`readonly: public GET ?action=seed -> status ${res.status}, body ${JSON.stringify(body)}, rows ${before} -> ${after}`);

  assert.equal(after, 0, "a public unauthenticated GET must NOT insert any rows");
  assert.notEqual(res.status, 200, "the public seed path must no longer succeed (read-only GET)");
  assert.equal(res.status, 405, "seed on the public GET is rejected as method-not-allowed");
});

test("EXECUTION: legitimate read GET ?action=list still works", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__ZONE_DB = db;

  const { GET } = await import("../app/api/service-zone/route.ts");
  const res = await GET(new Request("https://pawspace.example/api/service-zone?action=list", { method: "GET" }));
  assert.equal(res.status, 200, "list is a legitimate read action");
  const body = await res.json();
  assert.ok(Array.isArray(body.data), "list returns the zone catalogue");
  assert.ok(body.data.length > 0, "zone catalogue is non-empty");
});

test("EXECUTION: legitimate read GET ?action=resolve returns 404 for an unknown pincode (no write)", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__ZONE_DB = db;

  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS service_zone_mappings (pincode TEXT PRIMARY KEY, zone_id TEXT NOT NULL, city TEXT NOT NULL, area TEXT NOT NULL, created_at INTEGER NOT NULL)"),
  ]);
  const { GET } = await import("../app/api/service-zone/route.ts");
  const res = await GET(new Request("https://pawspace.example/api/service-zone?action=resolve&pincode=999999", { method: "GET" }));
  assert.equal(res.status, 404, "unknown pincode resolves to 404");
  const after = sqlite.prepare("SELECT COUNT(*) AS n FROM service_zone_mappings").get().n;
  assert.equal(after, 0, "a read resolve never writes rows");
});
