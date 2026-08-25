import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__FINAL_MAIN_AUDIT_DB__");

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const OPS_ROUTES = [
  "app/api/walking-ops/route.ts",
  "app/api/taxi-ops/route.ts",
  "app/api/food-ops/route.ts",
  "app/api/sitting-ops/route.ts",
  "app/api/boarding-ops/route.ts",
  "app/api/training-ops/route.ts",
  "app/api/food-supply-chain/route.ts",
];
const OPS_PATHS = ["walking-ops","taxi-ops","food-ops","sitting-ops","boarding-ops","training-ops","food-supply-chain"];

test("system-wide Ops GETs require bookings.manage at gateway and handler", async () => {
  const security = await import("../lib/platform-security.ts");
  const provider = security.defaultRoles.find((role) => role.code === "service_provider");
  assert.ok(provider, "service_provider role must exist");
  assert.ok(provider.permissions.includes("bookings.view"), "probe precondition: provider holds bookings.view");
  assert.ok(!provider.permissions.includes("bookings.manage"), "probe precondition: provider must not hold bookings.manage");

  const gateway = await read("lib/api-gateway.ts");
  for (const path of OPS_PATHS) {
    assert.match(gateway, new RegExp(`pathname===\\"/api/${path}\\"\\)return \\"bookings\\.manage\\"`),
      `${path} must stay behind bookings.manage at the central API gateway`);
  }

  for (const path of OPS_ROUTES) {
    const source = await read(path);
    const get = source.match(/export async function GET\([^]*?(?=export async function|$)/)?.[0] || "";
    assert.match(get, /requirePermission\(actor,["']bookings\.manage["']\)/,
      `${path} must keep its system-wide GET behind bookings.manage`);
    assert.doesNotMatch(get, /requirePermission\(actor,["']bookings\.view["']\)/,
      `${path} must not grant a system-wide snapshot to service_provider via bookings.view`);
  }
});

test("live Boarding and Sitting quote creation fails closed without city and zone", async () => {
  const { createLiveBoardingQuote, createLiveSittingQuote } = await import("../lib/live-commercial-quotes.ts");
  const futureStart = new Date(Date.now() + 86_400_000).toISOString();
  const futureEnd = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const dbThatMustNotBeTouched = new Proxy({}, {
    get() { throw new Error("database touched before location validation"); },
  });

  await assert.rejects(
    () => createLiveBoardingQuote(dbThatMustNotBeTouched, {
      packageCode: "boarding-daily", petCount: 1, scheduledStart: futureStart,
      scheduledEnd: futureEnd, paymentMode: "prepaid",
    }),
    (error) => error instanceof Response && error.status === 400,
  );

  await assert.rejects(
    () => createLiveSittingQuote(dbThatMustNotBeTouched, {
      packageCode: "sitting-visit-60", petCount: 1, scheduledStart: futureStart,
      scheduledEnd: futureEnd, paymentMode: "prepaid",
    }),
    (error) => error instanceof Response && error.status === 400,
  );
});

test("live quote location scope rejects a city-zone mismatch before persistence", async () => {
  const { createLiveSittingQuote } = await import("../lib/live-commercial-quotes.ts");
  const futureStart = new Date(Date.now() + 86_400_000).toISOString();
  const futureEnd = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const dbThatMustNotBeTouched = new Proxy({}, {
    get() { throw new Error("database touched before location validation"); },
  });

  await assert.rejects(
    () => createLiveSittingQuote(dbThatMustNotBeTouched, {
      packageCode: "sitting-visit-60", petCount: 1, scheduledStart: futureStart,
      scheduledEnd: futureEnd, paymentMode: "prepaid", cityId: "maa", zoneId: "blr-east",
    }),
    (error) => error instanceof Response && error.status === 409,
  );
});

test("public host-profile GET cannot seed demo data outside the explicit UAT gate", async () => {
  const source = await read("app/api/host-profile/route.ts");
  assert.match(source, /uatLoginEnabled\(env\).*seedDemoHostProfiles\(db\)/s,
    "demo profile seeding must stay behind the UAT environment gate");
  assert.doesNotMatch(source, /const db = await database\(\);\s*await seedDemoHostProfiles\(db\)/,
    "public GET must not unconditionally seed demo profiles");
});

test("Revenue CRM GET remains observational and mutation sweeps stay behind explicit writes", async () => {
  const source = await read("app/api/revenue-crm/route.ts");
  const get = source.match(/export async function GET\([^]*?(?=export async function POST)/)?.[0] || "";
  for (const mutator of ["seedUat", "runLeadReopening", "runSla", "enforceOps", "generateCommandReports", "runLeadCallbackSweep"]) {
    assert.doesNotMatch(get, new RegExp(`await\\s+${mutator}\\(`), `GET must not run ${mutator}`);
  }
  assert.match(source, /action===["']seed_uat["']/,
    "synthetic Revenue CRM data must require an explicit UAT-only write action");
  assert.match(source, /action===["']refresh_leaderboard["']/,
    "leaderboard recomputation must require an explicit staff write action");
});
