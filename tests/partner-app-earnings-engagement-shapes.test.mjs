import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// The Partner app Earnings tab against BOTH shapes providerWorkspace really returns.
//
// providerWorkspace builds a different object per engagement kind:
//   contract   -> netPayout/orders/grossOrderValue + computed.netPayout + settlements + incentives
//   commission -> netPayout/orders/grossOrderValue + computed.commissionAmount + commissionOrders
//                 + payouts, and NO settlements or incentives key at all.
//
// The tab read computed.netPayout, which does not exist on the commission shape, so every commission
// partner saw a governed zero while earnings.netPayout held the real figure. Worse, it then mapped the
// settlements list through an optional chain on `earnings` - which short-circuits one level too early to
// protect the list itself - so a commission partner opening the tab threw a TypeError into the error
// boundary instead of seeing their commission ledger.
//
// Both shapes below come out of the real providerWorkspace against real SQLite. Nothing here is a
// hand-copied fixture: if the library's per-engagement keys change, this fails rather than agreeing
// with a stale copy of them.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
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

const page = readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
const workspaceLib = await import("../lib/provider-workspace.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");
const commission = await import("../lib/provider-commission-governance.ts");

const PROVIDER = "groom_arun";

/**
 * A provider of the given engagement kind, then the REAL providerWorkspace read for them.
 *
 * Engagement is resolved from provider_capacity_profiles.provider_model, so that one column is what
 * selects between the two shapes - exactly as it does in production.
 */
async function workspaceFor(providerModel, { commissionAmount = 0, orderAmount = 0 } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  await capacity.ensureProviderCapacityTables(db);
  await commission.ensureProviderCommissionTables(db);
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(PROVIDER, "blr", "Arun R.", providerModel, JSON.stringify(["grooming"]), JSON.stringify(["koramangala"]), "2026-01-01", "ops.one@pawspace.in", 1);

  if (commissionAmount > 0) {
    sqlite.prepare("INSERT INTO provider_order_commissions (id,booking_id,work_order_id,provider_id,service_code,order_amount,commission_mode,commission_value,commission_amount,status,completed_at,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("COMM-1", "BK-9", "WO-9", PROVIDER, "grooming", orderAmount, "percent", 17, commissionAmount, "pending_confirmation", 1, 2, 1, 1);
  }

  return { sqlite, workspace: await workspaceLib.providerWorkspace(db, { providerId: PROVIDER }) };
}

/** The reads the Earnings tab now performs, in the page's own precedence order. */
const readTotals = (earnings) => ({
  netPayout: Number(earnings?.netPayout ?? earnings?.computed?.netPayout ?? earnings?.computed?.commissionAmount ?? 0),
  orders: Number(earnings?.orders ?? earnings?.computed?.orders ?? 0),
  gross: Number(earnings?.grossOrderValue ?? earnings?.computed?.grossOrderValue ?? 0),
});

test("provider_model really does select between two differently-keyed earnings shapes", async () => {
  const contract = await workspaceFor("contract");
  const commissionRun = await workspaceFor("commission");

  assert.equal(contract.workspace.engagement, "contract");
  assert.equal(commissionRun.workspace.engagement, "commission");

  // The premise of the whole defect, taken from the library rather than asserted about its source.
  assert.ok("settlements" in contract.workspace.earnings, "contract carries settlements");
  assert.ok("incentives" in contract.workspace.earnings, "contract carries incentives");
  assert.ok(!("settlements" in commissionRun.workspace.earnings), "commission has no settlements key");
  assert.ok(!("incentives" in commissionRun.workspace.earnings), "commission has no incentives key");
  assert.ok("commissionOrders" in commissionRun.workspace.earnings, "commission carries its order ledger");
  assert.ok("payouts" in commissionRun.workspace.earnings, "commission carries its payout states");
});

test("the old reads were a zero for commission partners and a crash on the ledger lists", async () => {
  const { workspace } = await workspaceFor("commission", { commissionAmount: 850, orderAmount: 5000 });
  const earnings = workspace.earnings;

  assert.equal(earnings.computed.netPayout, undefined,
    "computed.netPayout is the field the tab used to read, and the commission shape does not have it");
  assert.equal(earnings.netPayout, 850, "while the real figure sat on the top-level field all along");

  assert.throws(() => earnings?.settlements.map((item) => item),
    TypeError, "optional chaining stops at `earnings`, so the missing settlements key threw");
});

test("both engagement shapes now yield their real totals", async () => {
  const commissionRun = await workspaceFor("commission", { commissionAmount: 850, orderAmount: 5000 });
  assert.deepEqual(readTotals(commissionRun.workspace.earnings), { netPayout: 850, orders: 1, gross: 5000 },
    "a commission partner's earned commission must reach the screen, not a zero");

  const contract = await workspaceFor("contract");
  const totals = readTotals(contract.workspace.earnings);
  assert.equal(totals.netPayout, 0, "no payout computations were seeded, so zero is the honest answer here");
  assert.ok(Number.isFinite(totals.orders) && Number.isFinite(totals.gross));
});

test("an absent earnings object still reads as zero rather than throwing", () => {
  assert.deepEqual(readTotals(null), { netPayout: 0, orders: 0, gross: 0 });
  assert.deepEqual(readTotals(undefined), { netPayout: 0, orders: 0, gross: 0 });
});

test("the workspace also reports the states the tab used to drop", async () => {
  const { workspace } = await workspaceFor("commission");
  for (const key of ["engagement", "onboardingStatus", "pendingProof", "liveAssignments", "bookings"]) {
    assert.ok(key in workspace, `${key} is returned and must not be discarded again`);
  }
});

test("every per-engagement list is defaulted before .map in the page source", () => {
  for (const key of ["settlements", "incentives", "commissionOrders", "payouts"]) {
    assert.match(page, new RegExp(`\\(earnings\\.${key} \\?\\? \\[\\]\\)\\.map`),
      `${key} must be defaulted, because it is absent on the other engagement shape`);
  }
});

test("the tab reads the top-level totals, not the per-engagement computed block", () => {
  assert.doesNotMatch(page, /money\(earnings\?\.computed\.netPayout \?\? 0\)/,
    "computed.netPayout is undefined for commission partners");
  assert.match(page, /earnings\?\.netPayout \?\? earnings\?\.computed\?\.netPayout \?\? earnings\?\.computed\?\.commissionAmount/);
});

test("the unlinked and withheld states are explained instead of rendered as zero", () => {
  assert.match(page, /linked === false/, "a 200 with linked:false must not render as zero rupees");
  assert.match(page, /earningsNotice/);
  assert.match(page, /visible === false/, "earnings.visible is a governance flag, not decoration");
});

test("the commission ledger and its payout states are rendered somewhere", () => {
  assert.match(page, /earnings\.commissionOrders/);
  assert.match(page, /earnings\.payouts/);
});
