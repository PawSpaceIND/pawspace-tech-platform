/*
 * Every API route a customer or partner screen calls must be registered in the SESSION gateway.
 *
 * worker/index.ts authorizes each /api request as `sessionAccess ?? await authorizeApiRequest(...)`:
 * the session gateway (lib/session-api-gateway.ts, sessionScope) gets first refusal, and anything it
 * does not claim falls through to the STAFF gateway. That staff gateway is a hand-written if-chain
 * over ~187 paths ending in a catch-all:
 *
 *     return "dashboard.view";          // lib/api-gateway.ts
 *
 * `dashboard.view` is a permission staff hold and the `service_provider` and `customer` roles do not
 * (lib/platform-security.ts). So a provider-facing route that nobody registered is not merely
 * unenumerated - it is 403 for the exact persona it was written for, no matter what its own handler
 * permits. The failure is silent, total, and invisible to every staff tester.
 *
 * Three routes shipped that way: /api/provider-service-rates (a provider could not load or save
 * their own pricing), /api/partner-jobs (the job list was empty on /partner-app, /partner-mobile and
 * /groomer) and /api/grooming-payment-sandbox (a partner could never request payment after a
 * service). The last two are the sharpest illustration: /api/partner-jobs re-exports its handler
 * from /api/partner-grooming-jobs, which WAS registered and worked - identical code, reachable
 * through one path and 403 through the other.
 *
 * tests/provider-scope-precedence.test.mjs already pins PROVIDER_SCOPED_API_PATHS in both
 * directions, and it passed throughout, which is precisely why this class slipped through: nothing
 * connected the set of routes the non-staff UI actually calls to the set the gateways admit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

nodeModule.register(new URL("./helpers/ts-extension-loader.mjs", import.meta.url));

/* The two gateway decisions are EXECUTED, not grepped. An earlier draft asserted that a route string
 * appeared in a gateway source file, which is exactly the class of test tests/test-suite-executes-code
 * exists to discourage: it cannot tell a live registration from a commented-out one, from a mention
 * in a comment, or from a branch guarded by a method this route never receives. Calling the real
 * functions also lets GATEWAY-3 prove the catch-all by observing it resolve an unknown path, rather
 * than by matching a regex against the source. */
const { sessionScope } = await import("../lib/session-api-gateway.ts");
const { requiredPermission } = await import("../lib/api-gateway.ts");

/** The permission lib/api-gateway.ts falls back to when nothing matched. */
const CATCH_ALL = "dashboard.view";

/** Ask the real gateways, exactly as worker/index.ts does: session first, then staff. */
async function resolveRoute(route, method) {
  const request = new Request(`https://app.pawspace.test${route}`, { method });
  const scope = await sessionScope(request);
  if (scope) return { gateway: "session", permission: scope.permission };
  return { gateway: "staff", permission: await requiredPermission(request) };
}

/* The UI scan yields a path but not the verb, and several registrations are verb-specific, so a
 * route counts as reachable when ANY of the verbs a screen can use resolves it. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
async function reachableForNonStaff(route) {
  for (const method of METHODS) {
    const { gateway, permission } = await resolveRoute(route, method);
    if (gateway === "session") return true;
    if (permission !== CATCH_ALL) return true;
  }
  return false;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

/** Directories whose pages are rendered for a customer or a partner, never for staff. */
const NON_STAFF_UI = ["mobile-app","partner","partner-app","partner-mobile","host","driver","groomer",
  "sitter","trainer","walker","account","grooming","boarding","sitting","taxi","training","walking","food"];

function walk(dir, hit, out = []) {
  if (!existsSync(path.join(ROOT, dir))) return out;
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, hit, out);
    else if (hit(entry.name)) out.push(rel);
  }
  return out;
}

const API_ROUTES = walk("app/api", (n) => n === "route.ts")
  .map((f) => "/" + path.relative("app", path.dirname(f)).split(path.sep).join("/"));

/* Quoted AND backticked call sites both count - the partner job list is a template literal, and a
 * quote-only scan reports it as uncalled. Longest-match resolution stops /api/provider-onboarding
 * from swallowing a call to /api/provider-onboarding-self-service. */
function routesCalledFrom(dir) {
  const called = new Set();
  for (const file of walk(dir, (n) => n.endsWith(".tsx") || n.endsWith(".ts"))) {
    for (const m of read(file).matchAll(/["`]\/api\/([A-Za-z0-9/_-]+)/g)) {
      const candidate = "/api/" + m[1];
      const exact = API_ROUTES.filter((r) => candidate === r || candidate.startsWith(r + "?") || candidate.startsWith(r + "/"))
        .sort((a, b) => b.length - a.length)[0];
      if (exact) called.add(exact);
    }
  }
  return called;
}


/* Routes a non-staff page references but which are genuinely staff-only: the page links to them for
 * a signed-in staff viewer, or references the string without calling it as that persona. Each entry
 * is a deliberate exemption, not a silence - adding one should require knowing why. */
const STAFF_ONLY_FROM_NON_STAFF_UI = new Set([]);

test("GATEWAY-1: every API route a customer or partner screen calls is reachable for that persona", async () => {
  const unreachable = [];
  for (const dir of NON_STAFF_UI) {
    for (const route of routesCalledFrom(`app/${dir}`)) {
      if (STAFF_ONLY_FROM_NON_STAFF_UI.has(route)) continue;
      /* Reachable if EITHER gateway claims it. The staff gateway assigns many of these a
       * permission the persona happens to hold (self_service.view, bookings.view, scheduling.book)
       * or treats them as public, and those work today - an earlier draft of this test demanded
       * session registration for all of them and would have forced 38 needless changes. The bug is
       * specifically a route in NEITHER gateway, which therefore hits the dashboard.view catch-all.
       *
       * Known limitation: a route enumerated in the staff gateway under a staff-only permission,
       * whose handler has a provider branch, is still broken and is NOT caught here
       * (/api/grooming-payment-sandbox was exactly that - blanket payments.manage over a provider
       * action). Catching that needs permission modelling per persona; until then it is covered by
       * the session-gateway registration rather than by this scan. */
      if (await reachableForNonStaff(route)) continue;
      unreachable.push(`${route}  <- called from app/${dir}/`);
    }
  }
  assert.deepEqual([...new Set(unreachable)], [],
    `these routes are called by a non-staff screen but are not registered in lib/session-api-gateway.ts,\n` +
    `so the staff gateway's catch-all resolves "dashboard.view" and the persona gets 403:\n  ` +
    [...new Set(unreachable)].join("\n  "));
});

test("GATEWAY-2: the scan sees real routes and real call sites", async () => {
  /* A scan that resolved nothing would make GATEWAY-1 pass for ever. */
  assert.ok(API_ROUTES.length > 200, `expected the app to have many API routes, found ${API_ROUTES.length}`);
  const partnerCalls = routesCalledFrom("app/partner-app");
  assert.ok(partnerCalls.size > 3, `expected the partner app to call several APIs, found ${partnerCalls.size}`);
  assert.ok(partnerCalls.has("/api/partner-jobs"),
    "the partner job list is fetched with a template literal - a quote-only scan misses it and this test goes blind");
  const twin = await resolveRoute("/api/partner-grooming-jobs", "GET");
  assert.equal(twin.gateway, "session",
    `expected the known-good twin to resolve in the SESSION gateway; it resolved via ${twin.gateway} as ${twin.permission}. If this fails the resolver itself is wrong and GATEWAY-1 proves nothing.`);
});

test("GATEWAY-3: the staff catch-all still exists, so this guard is still needed", async () => {
  /* If the catch-all is ever replaced by a fail-closed default, this whole class disappears and this
   * test should be revisited rather than silently kept. */
  /* Observed, not grepped: a path no branch can possibly match must come back as the catch-all. */
  const unknown = await resolveRoute("/api/route-that-does-not-exist-" + Date.now(), "GET");
  assert.equal(unknown.gateway, "staff");
  assert.equal(unknown.permission, CATCH_ALL,
    `lib/api-gateway.ts no longer falls back to ${CATCH_ALL} (an unknown path resolved to ${unknown.permission}). ` +
    "If it now fails closed, this whole class of bug disappears - revisit GATEWAY-1 rather than silently keeping it.");
});
