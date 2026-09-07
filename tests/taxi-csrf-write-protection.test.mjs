/*
 * Cross-site write protection for the Pet Taxi surface, and the invariant it rests on.
 *
 * WHY THIS EXISTS, precisely - because the finding was smaller than it first looked and the reason
 * matters more than the fix:
 *
 * Five of the seven Pet Taxi POST routes (finance, lifecycle, ops, proof, recovery) had no
 * same-origin check, while taxi-bookings and taxi-commercial did. resolveActor authenticates through
 * resolvePlatformSession, which reads a browser COOKIE, so on the face of it an attacker's page
 * could have posted to those five with the victim's credentials attached.
 *
 * It could not, and the reason is one line in a different file: lib/platform-session.ts issues that
 * cookie `SameSite=Lax`, and Lax withholds cookies on cross-site POST. So the five unguarded routes
 * were safe - but safe by an attribute declared somewhere else, with nothing recording the
 * dependency. Set that cookie to SameSite=None one day to support an embedded widget or a second
 * domain, and five money-and-lifecycle routes silently become forgeable, while two do not.
 *
 * This suite closes it from both sides: every Pet Taxi POST route now refuses a cross-origin write
 * on its own, AND the cookie attribute that was doing the work is pinned so it cannot be relaxed
 * without a test going red.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__TAXI_CSRF_DB__", "__TAXI_CSRF_ENV__");

const ORIGIN = "https://app.pawspace.test";
const ATTACKER = "https://evil.example";
const STAFF = "taxi.ops@pawspace.in";

function makeD1(sqlite) {
  const stmt = (sql, args) => ({
    bind: (...b) => stmt(sql, b),
    first: async (col) => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : (col ? r[col] : r); },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
  });
  return {
    prepare: (sql) => stmt(sql, []),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const TAXI_WRITE_ROUTES = ["taxi-bookings", "taxi-commercial", "taxi-finance",
                           "taxi-lifecycle", "taxi-ops", "taxi-proof", "taxi-recovery"];

let ready;
async function world() {
  if (ready) return ready;
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__TAXI_CSRF_DB__ = db;
  globalThis.__TAXI_CSRF_ENV__ = { APP_ENV: "staging" };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-TAXI-OPS',?,?, 'admin','active',?,?)")
    .run(STAFF, STAFF, now, now);
  ready = { sqlite, db };
  return ready;
}

const crossOrigin = (route) => new Request(`${ORIGIN}/api/${route}`, {
  method: "POST",
  headers: { origin: ATTACKER, "content-type": "application/json", "oai-authenticated-user-email": STAFF },
  body: JSON.stringify({ bookingId: "BK-CSRF-1", action: "complete_trip", idempotencyKey: "IDEM-CSRF-1" }),
});

const sameOrigin = (route) => new Request(`${ORIGIN}/api/${route}`, {
  method: "POST",
  headers: { origin: ORIGIN, "content-type": "application/json", "oai-authenticated-user-email": STAFF },
  body: JSON.stringify({}),
});

test("TAXI-CSRF-1: every Pet Taxi write route refuses a cross-origin POST with 403", async () => {
  await world();
  const verdicts = [];
  for (const route of TAXI_WRITE_ROUTES) {
    const mod = await import(`../app/api/${route}/route.ts`);
    const response = await mod.POST(crossOrigin(route));
    verdicts.push([route, response.status]);
  }
  const notRefused = verdicts.filter(([, status]) => status !== 403);
  assert.deepEqual(notRefused, [],
    `these Pet Taxi routes accepted a cross-origin write: ${JSON.stringify(notRefused)}`);
});

test("TAXI-CSRF-2: the refusal is the ORIGIN, not the payload - a same-origin call gets past it", async () => {
  /* Non-vacuity. Every route above would also "refuse" a malformed body with a 400, and a suite that
   * only checked "not 200" would pass on a route with no origin check at all. This asserts the
   * same-origin call reaches real handler logic and fails for a DIFFERENT reason than 403. */
  await world();
  const stillForbidden = [];
  for (const route of TAXI_WRITE_ROUTES) {
    const mod = await import(`../app/api/${route}/route.ts`);
    const response = await mod.POST(sameOrigin(route));
    if (response.status === 403) stillForbidden.push(route);
  }
  assert.deepEqual(stillForbidden, [],
    `these routes returned 403 to a SAME-origin caller, so TAXI-CSRF-1 proves nothing about origin: ${stillForbidden}`);
});

test("TAXI-CSRF-3: a request with no Origin header is not blocked", async () => {
  /* Server-to-server and non-browser callers send no Origin. The guard must key on a MISMATCH, not
   * on absence, or adding it breaks every internal caller. */
  await world();
  const mod = await import("../app/api/taxi-lifecycle/route.ts");
  const response = await mod.POST(new Request(`${ORIGIN}/api/taxi-lifecycle`, {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": STAFF },
    body: JSON.stringify({}),
  }));
  assert.notEqual(response.status, 403, "a request with no Origin header was treated as cross-origin");
});

test("TAXI-CSRF-4: the platform session cookie stays SameSite=Lax or Strict", () => {
  /* This is the invariant the five unguarded routes were silently relying on. It lives in a
   * different file from the routes it protects, so it is pinned here explicitly: relaxing it to
   * SameSite=None turns every cookie-authenticated POST in the product into a cross-site write
   * unless that route carries its own check. */
  const source = readFileSync(new URL("../lib/platform-session.ts", import.meta.url), "utf8");
  const attrs = source.match(/SameSite=([A-Za-z]+)/g) || [];
  assert.ok(attrs.length > 0, "the session cookie declares no SameSite attribute at all");
  const relaxed = attrs.filter((a) => !/SameSite=(Lax|Strict)/.test(a));
  assert.deepEqual(relaxed, [],
    `the platform session cookie is no longer SameSite-restricted: ${relaxed.join(", ")}. ` +
    `Every cookie-authenticated POST route now needs its own same-origin check.`);
});

test("TAXI-CSRF-5: no Pet Taxi route regresses by losing its guard", () => {
  /* A source check on purpose, and the reason is the same one that keeps the absence assertions in
   * tests/meta-whatsapp-webhook.test.mjs: this is a negative over a set of files. TAXI-CSRF-1 drives
   * the routes and is the real evidence; this catches a NEW taxi write route added without a guard,
   * which no executing test can see because it does not know the route exists yet.
   *
   * Comments are stripped first. The first draft of this assertion did not strip them, and under
   * sabotage - commenting out one route's sameOriginWrite call - it stayed GREEN while TAXI-CSRF-1
   * went red. A source scan that counts an identifier inside a comment is the precise weakness this
   * whole workstream exists to remove, and it had reproduced itself here. */
  const dir = new URL("../app/api/", import.meta.url);
  const taxiRoutes = readdirSync(dir).filter((d) => d.startsWith("taxi-"));
  assert.ok(taxiRoutes.length >= TAXI_WRITE_ROUTES.length,
    `expected at least ${TAXI_WRITE_ROUTES.length} taxi route directories, found ${taxiRoutes.length}`);
  const unguarded = taxiRoutes.filter((d) => {
    let src;
    try { src = readFileSync(new URL(`../app/api/${d}/route.ts`, import.meta.url), "utf8"); }
    catch { return false; }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (!/export async function POST/.test(code)) return false;
    return !/sameOriginWrite\(request\)/.test(code);
  });
  assert.deepEqual(unguarded, [],
    `these Pet Taxi routes accept writes with no same-origin guard: ${unguarded.join(", ")}`);
});
