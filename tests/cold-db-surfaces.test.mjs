import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// Regression: staff surfaces must not 500 on a COLD database (fresh staging D1
// where no booking/people module has run yet). Found by an end-to-end sweep:
// /api/manager-dashboard ("no such table: employees"), /api/walking-ops and
// /api/taxi-ops ("no such table: provider_capacity_profiles") all crashed.
// The real route handlers execute here against a truly empty node:sqlite DB.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl = ${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const managerDashboardRoute = await import("../app/api/manager-dashboard/route.ts");
const walkingOpsRoute = await import("../app/api/walking-ops/route.ts");
const taxiOpsRoute = await import("../app/api/taxi-ops/route.ts");

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

// A completely empty database: not a single application table pre-created.
function coldDb() {
  globalThis.__PAWSPACE_TEST_ENV = { DB: makeD1(new DatabaseSync(":memory:")) };
}

test("cold DB: /api/manager-dashboard returns an empty dashboard instead of 'no such table: employees'", async () => {
  coldDb();
  const response = await managerDashboardRoute.GET(new Request("http://localhost/api/manager-dashboard"));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()).slice(0, 200));
  const { data } = await response.json();
  assert.equal(data.employeeCount, 0);
  assert.deepEqual(data.verticals.sales, []);
});

test("cold DB: /api/walking-ops returns an empty exception queue instead of a 500", async () => {
  coldDb();
  const response = await walkingOpsRoute.GET(new Request("http://localhost/api/walking-ops"));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()).slice(0, 200));
  const { data } = await response.json();
  assert.equal(data.metrics.total, 0);
  assert.deepEqual(data.bookings, []);
});

test("cold DB: /api/taxi-ops returns an empty exception queue instead of a 500", async () => {
  coldDb();
  const response = await taxiOpsRoute.GET(new Request("http://localhost/api/taxi-ops"));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()).slice(0, 200));
  const { data } = await response.json();
  assert.equal(data.metrics.total, 0);
  assert.deepEqual(data.bookings, []);
});

test("the CRM revenue-engine panel surfaces the real failure instead of a blanket 'check your access'", () => {
  const panel = fs.readFileSync("app/crm/revenue-engine-panel.tsx", "utf8");
  assert.match(panel, /describeLoadFailure/);
  assert.match(panel, /HTTP \$\{response\.status\}/, "the shown message must carry the real HTTP status");
  assert.match(panel, /response\.status===401\|\|response\.status===403/, "access wording is reserved for real 401/403");
  assert.match(panel, /not a permission problem/, "server errors must say they are not an access issue");
  assert.doesNotMatch(panel, /catch\(\(\)=>\{if\(active\)setError\("Revenue engine could not load\. Check your CRM access\."\)\}\)/, "the old blanket message is gone");
});
