import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Test-only resolve hook (same pattern as tests/customer-offers.test.mjs) so real libs with
// extensionless relative imports execute directly under --experimental-strip-types.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const lifecycleRoute = read("app/api/grooming-lifecycle/route.ts");
const partnerJobsRoute = read("app/api/partner-grooming-jobs/route.ts");
const changeRoute = read("app/api/grooming-booking-change/route.ts");
const groomingRouteApi = read("app/api/grooming-route/route.ts");
const walletRoute = read("app/api/subscription-wallet/route.ts");
const walletLib = read("lib/subscription-wallet.ts");
const partnerJobsUi = read("app/partner-app/canonical-grooming-jobs.tsx");
const routeCardUi = read("app/partner-app/grooming-route-card.tsx");
const recoveryRoute = read("app/api/provider-assignment-recovery/route.ts");

// Statement-level legacy tests execute extracted SQL outside the canonical lifecycle transaction.
// Replace only the interpolated lifecycle predicate in that isolated harness; provider-lifecycle-d1
// separately executes and proves the real guard, assertion and rollback contract end to end.
const statementsOf = (source) =>
  [...source.matchAll(/\.prepare\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) => m[2].replace(/\\(["'`\\])/g, "$1").replaceAll("${ctx.guardSql}", "1=1"));
const findStatement = (source, marker) => {
  const hit = statementsOf(source).find((sql) => sql.includes(marker));
  assert.ok(hit, `expected a prepared statement containing: ${marker}`);
  return hit;
};

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
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (stmts) => {
      for (const s of stmts) await s.run();
      return [];
    },
  };
}

test("grooming lifecycle and partner jobs stay permission-gated", () => {
  assert.match(lifecycleRoute, /requirePermission/);
  assert.match(partnerJobsRoute, /requirePermission/);
  assert.match(changeRoute, /requirePermission/);
  assert.match(groomingRouteApi, /export async function GET/);
  assert.match(groomingRouteApi, /export async function POST/);
  assert.match(groomingRouteApi, /requireProviderOwnership/);
  assert.match(groomingRouteApi, /GPS_CAPTURE_STATES/);
});

test("grooming stack permission mapping stays enforced in-route", () => {
  assert.match(lifecycleRoute, /bookings\.manage|bookings\.view/);
  assert.match(partnerJobsRoute, /bookings\.view/);
  assert.match(changeRoute, /bookings\.manage/);
});

test("partner UI keeps route card and canonical jobs wired", () => {
  assert.match(partnerJobsUi, /GroomingRouteCard/);
  assert.match(routeCardUi, /\/api\/grooming-route/);
  assert.match(routeCardUi, /navigator\.geolocation/);
});

test("subscription wallet surfaces stay staff-gated for consume/release", () => {
  assert.match(walletLib, /SubscriptionWalletAction/);
  assert.match(walletRoute, /requirePermission\(actor,"bookings\.manage"\)/, "consume/release stay staff-gated");
});

test("provider assignment recovery is permission gated", () => {
  assert.match(recoveryRoute, /requirePermission/);
});
