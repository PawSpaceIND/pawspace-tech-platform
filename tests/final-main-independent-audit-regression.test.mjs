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

test("public Host Profile and Training Ops reads cannot seed synthetic records", async () => {
  const host = await read("app/api/host-profile/route.ts");
  const hostGet = host.match(/export async function GET\([^]*?(?=export async function|$)/)?.[0] || "";
  assert.doesNotMatch(hostGet, /seedDemoHostProfiles\(/,
    "Host Profile GET must be strictly observational");

  const training = await read("app/api/training-ops/route.ts");
  const trainingGet = training.match(/export async function GET\([^]*?(?=export async function|$)/)?.[0] || "";
  assert.doesNotMatch(trainingGet, /seedProviderCapacityDefaults\(/,
    "Training Ops GET must not create synthetic provider capacity");
  assert.match(trainingGet, /ensureProviderCapacityTables\(/,
    "Training Ops GET may ensure schema but must not seed synthetic providers");
});

test("synthetic UAT mutation surfaces require both isolated UAT and sandbox payments", async () => {
  const swarm = await read("app/api/prelaunch-booking-swarm/route.ts");
  const swarmPost = swarm.match(/export async function POST\([^]*$/)?.[0] || "";
  assert.match(swarmPost, /uatLoginEnabled\(runtime\)/,
    "prelaunch swarm must require the explicit UAT login gate");
  assert.match(swarmPost, /PAWSPACE_PAYMENT_ENV[^]*?sandbox/,
    "prelaunch swarm must require sandbox payments");

  const crm = await read("app/api/revenue-crm/route.ts");
  const crmGet = crm.match(/export async function GET\([^]*?(?=export async function POST)/)?.[0] || "";
  for (const mutator of ["seedUat", "runLeadReopening", "runSla", "enforceOps", "generateCommandReports", "runLeadCallbackSweep"]) {
    assert.doesNotMatch(crmGet, new RegExp(`await\\s+${mutator}\\(`), `GET must not run ${mutator}`);
  }
  assert.match(crm, /action===["']seed_uat["'][^]*?PAWSPACE_UAT_LOGIN[^]*?PAWSPACE_UAT_SIGNING_KEY[^]*?PAWSPACE_PAYMENT_ENV[^]*?["']sandbox["']/,
    "Revenue CRM seed_uat must require UAT login, signing key and sandbox payments");
  assert.match(crm, /action===["']refresh_leaderboard["']/,
    "leaderboard recomputation must remain an explicit staff write action");
});

test("locationless identities and catalogue reads never silently become Bengaluru", async () => {
  for (const path of ["lib/customer-otp.ts", "lib/partner-otp.ts"]) {
    const source = await read(path);
    assert.doesNotMatch(source, /input\.cityId\s*(?:\|\||\?\?)\s*["']blr["']/,
      `${path} must never default a missing identity location to BLR`);
  }

  const customerOtp = await read("lib/customer-otp.ts");
  assert.match(customerOtp, /text\(input\.cityId\)\|\|["']unassigned["']/,
    "the NOT NULL customer schema must represent absent geography explicitly, not as a real city");
  assert.match(customerOtp, /customerCityId===["']unassigned["']\?null/,
    "the explicit unassigned storage sentinel must leave the signed identity assertion locationless");

  const boarding = await read("app/api/boarding-commercial/route.ts");
  assert.doesNotMatch(boarding, /searchParams\.get\(["']cityId["']\)\s*\|\|\s*["']blr["']/,
    "Boarding catalogue GET must not default a missing city to BLR");
  assert.doesNotMatch(boarding, /searchParams\.get\(["']zoneId["']\)\s*\|\|\s*["']blr-east["']/,
    "Boarding catalogue GET must not default a missing zone to BLR East");
  assert.match(boarding, /hasLocation=Boolean\(cityId&&zoneId\)/,
    "Boarding catalogue must distinguish requests that have explicit geography");
  assert.match(boarding, /availabilityMode:hasLocation\?\(windowAware\?["']uat_canonical["']:["']catalogue_only["']\):["']location_required["']/,
    "locationless Boarding catalogue reads must be explicitly marked location_required");
});

test("governed pricing writes and quotes require explicit city and zone without schema fallback", async () => {
  const control = await read("app/api/pricing-control/route.ts");
  assert.doesNotMatch(control, /city_id text DEFAULT ['"]blr['"] NOT NULL/,
    "new pricing rule schema must not silently assign BLR");
  const controlPost = control.match(/export async function POST\([^]*$/)?.[0] || "";
  assert.match(controlPost, /cityId\?:string;zoneId\?:string/,
    "pricing rule creation must accept explicit city and zone");
  assert.match(controlPost, /!cityId\|\|!zoneId/,
    "pricing rule creation must reject a missing city or zone");

  const quote = await read("app/api/pricing-quote/route.ts");
  assert.match(quote, /!cityId\|\|!zoneId/,
    "pricing quote must reject a missing city or zone");
  assert.doesNotMatch(quote, /cityId:body\.cityId\s*(?:\?\?|\|\|)\s*["']blr["']/,
    "pricing quote must never synthesize BLR for a missing city");
});

test("Haptik slots and Grooming tax policy reject missing geography", async () => {
  const haptik = await read("app/api/haptik/route.ts");
  const slotBranch = haptik.match(/if\(action===["']fetch_slots["']\)[^]*?(?=if\(action===|return json\(\{error:["']Unsupported Haptik action)/)?.[0] || "";
  assert.match(slotBranch, /!cityId\|\|!zoneId/,
    "Haptik fetch_slots must require explicit city and zone");
  assert.match(slotBranch, /json\([^]*?,400\)/,
    "Haptik fetch_slots must return a governed 400 when geography is missing");

  const grooming = await read("app/api/grooming-finance/route.ts");
  assert.match(grooming, /action===["']save_tax_policy["'][^]*?!cityId[^]*?status:400/,
    "Grooming tax policy writes must require an explicit city");
  assert.doesNotMatch(grooming, /cityId:String\(body\.cityId\|\|["']blr["']\)/,
    "Grooming tax policy must not silently fall back to BLR");
});
