import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

// The GET handler in app/api/service-zone/route.ts imports "cloudflare:workers" and reads env.DB.
// Install the resolver so that import resolves to a shim reading globalThis.__ZONE_DB.
installWorkersHooks("__ZONE_DB");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Minimal D1 shim over node:sqlite (same shape as other execution suites).
function makeD1(sqlite) {
  // Uses the transactional D1 shim (BEGIN/COMMIT/ROLLBACK) from helpers/d1.mjs so a
  // failing batch() rolls back, exactly as Cloudflare D1 does.
  return createD1(sqlite);
}

// ---------------------------------------------------------------------------
// FINDING 11 (P2 SECURITY / DATA INTEGRITY) — FIXED.
// The public, unauthenticated GET is now READ-ONLY. /api/service-zone is still in
// the gateway's null (public) list, but GET ...?action=seed no longer writes: it
// returns 405 and inserts ZERO rows. Seeding is an operator task via staff tooling.
// list/resolve reads still work.
// ---------------------------------------------------------------------------

test("Finding 11a: /api/service-zone is declared PUBLIC (returns null permission) at the gateway", () => {
  const gw = read("lib/api-gateway.ts");
  // The public null-list: any of these pathnames => `return null` (no permission required).
  const match = /if\(url\.pathname==="\/api\/pricing-quote"[\s\S]*?\)return null;/.exec(gw);
  assert.ok(match, "could not locate the gateway public null-list");
  assert.match(match[0], /url\.pathname==="\/api\/service-zone"/,
    "/api/service-zone remains in the public null-list — which is exactly why its GET must be read-only");
  console.log("Finding 11a: /api/service-zone IS in the gateway public null-list (requiredPermission => null).");
});

test("Finding 11b FIXED: GET action=seed no longer routes to seedDefaultZones — it returns 405 (read-only endpoint)", () => {
  const route = read("app/api/service-zone/route.ts");
  // The GET handler must NOT call seedDefaultZones anymore.
  assert.doesNotMatch(route, /if\(action==="seed"\)\{\s*await seedDefaultZones\(db\)/,
    "GET handler must NOT seed on action=seed");
  assert.doesNotMatch(route, /await seedDefaultZones\(/, "the GET route no longer invokes seedDefaultZones at all");
  // Instead, action=seed is refused with a 405.
  assert.match(route, /if\(action==="seed"\)return new Response[\s\S]*?status:405/,
    "GET ?action=seed must return a 405 refusal");
  console.log("Finding 11b: GET ?action=seed -> 405, no seedDefaultZones call (read-only public endpoint).");
});

test("Finding 11c FIXED: EXECUTION — public GET ?action=seed writes NO rows (stays 0) and returns 405; list/resolve reads still work", async () => {
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
  assert.equal(res.status, 405, "the public GET seed is now REFUSED with 405");
  const body = await res.json();

  const after = sqlite.prepare("SELECT COUNT(*) AS n FROM service_zone_mappings").get().n;
  console.log(`Finding 11c: public GET ?action=seed response = ${JSON.stringify(body)}`);
  console.log(`Finding 11c: service_zone_mappings row count ${before} -> ${after} (NO rows inserted by an unauthenticated GET).`);
  assert.equal(after, 0, "a public unauthenticated GET INSERTED nothing — DB mutation via public GET is BLOCKED");

  // list/resolve reads still work through the same public endpoint.
  const list = await GET(new Request("https://pawspace.example/api/service-zone?action=list", { method: "GET" }));
  assert.equal(list.status, 200, "action=list still returns 200 (reads preserved)");
  const resolve = await GET(new Request("https://pawspace.example/api/service-zone?action=resolve&pincode=560001", { method: "GET" }));
  assert.equal(resolve.status, 200, "action=resolve of a real Bengaluru pincode still returns 200 (reads preserved)");
});

// ---------------------------------------------------------------------------
// FINDING 12 (P2) — FIXED. Provider onboarding no longer surfaces RAW API error
// bodies to users. app/partner/onboarding/page.tsx routes non-OK responses through
// safeApiError(), which logs the raw body for diagnostics only and returns a
// controlled, human-readable message (401/403 -> a safe sign-in prompt, else a
// generic retry message). No `throw new Error(await r.text())` sites remain.
// ---------------------------------------------------------------------------

test("Finding 12 FIXED: refresh, submit and initial-load paths map errors through safeApiError — no raw body reaches the UI", () => {
  const ui = read("app/partner/onboarding/page.tsx");

  // No raw-body throws remain anywhere in the page.
  const rawHits = ui.split("\n").filter((line) => /throw new Error\(await r\.text\(\)\)/.test(line));
  assert.equal(rawHits.length, 0, `no raw \`throw new Error(await r.text())\` sites may remain, found ${rawHits.length}`);
  assert.doesNotMatch(ui, /throw new Error\(await r\.text\(\)\)/, "the raw-body throw is gone");

  // A safeApiError mapper exists and maps 401/403 -> a controlled message, else a generic one.
  assert.match(ui, /async function safeApiError\(r: Response\)/, "safeApiError mapper exists");
  assert.match(ui, /r\.status === 401 \|\| r\.status === 403/, "401/403 are mapped specifically");
  assert.match(ui, /"Please sign in as a verified provider to continue\."/, "safe 401/403 message");
  assert.match(ui, /"Something went wrong\. Please try again\."/, "generic fallback message");

  // refresh() and post()/submit throw the MAPPED error, not raw text.
  assert.match(ui, /function refresh\(\)\s*\{[\s\S]*?if \(!r\.ok\) throw await safeApiError\(r\)/,
    "refresh() routes non-OK through safeApiError");
  assert.match(ui, /async function post\([\s\S]*?if \(!r\.ok\) throw await safeApiError\(r\)/,
    "post()/submit routes non-OK through safeApiError");

  // The raw body is only LOGGED for diagnostics, never rendered.
  assert.match(ui, /console\.error\("provider-onboarding-self-service", r\.status, await r\.clone\(\)\.text\(\)\)/,
    "the raw body is logged for diagnostics only");
  console.log("Finding 12: all non-OK paths go through safeApiError(); no raw `await r.text()` throw remains.");
});

test("Finding 12: the gateway still returns raw 401/403 JSON — now mapped by safeApiError to a safe message, never rendered verbatim", () => {
  const gw = read("lib/api-gateway.ts");
  // These are the exact raw JSON bodies the gateway returns for the self-service endpoint
  // when the caller is unauthenticated / unauthorized.
  assert.match(gw, /Response\.json\(\{error:"Authentication required"\},\{status:401\}\)/);
  assert.match(gw, /Response\.json\(\{error:"Permission denied"\},\{status:403\}\)/);
  // The onboarding page no longer renders these raw bodies — it maps the status to a controlled message.
  const ui = read("app/partner/onboarding/page.tsx");
  assert.doesNotMatch(ui, /throw new Error\(await r\.text\(\)\)/, "raw gateway bodies are no longer thrown into the UI");
  console.log('Finding 12: raw 401/403 gateway bodies are mapped by safeApiError -> "Please sign in as a verified provider to continue."');
});
