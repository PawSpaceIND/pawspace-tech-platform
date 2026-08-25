import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("system-wide operations dashboards require booking management authority",async()=>{
  const paths=[
    "app/api/walking-ops/route.ts",
    "app/api/taxi-ops/route.ts",
    "app/api/food-ops/route.ts",
    "app/api/sitting-ops/route.ts",
    "app/api/boarding-ops/route.ts",
    "app/api/food-supply-chain/route.ts",
    "app/api/training-ops/route.ts",
    "app/api/ops-work-queue/route.ts",
    "app/api/unified-cases/route.ts",
  ];
  for(const path of paths){
    const source=await read(path);
    assert.match(source,/requirePermission\(actor,"bookings\.manage"\)|authorize\(request,"bookings\.manage"\)/,`${path} must not expose a system-wide dashboard to bookings.view alone`);
  }
});

test("public/read dashboards do not seed synthetic host or training data",async()=>{
  const host=await read("app/api/host-profile/route.ts");
  const training=await read("app/api/training-ops/route.ts");
  assert.doesNotMatch(host,/seedDemoHostProfiles\s*\(/);
  assert.doesNotMatch(training,/seedProviderCapacityDefaults\s*\(/);
  assert.match(training,/ensureProviderCapacityTables\s*\(/);
});

test("Revenue CRM GET is read-only and synthetic initialization is explicit UAT-only",async()=>{
  const source=await read("app/api/revenue-crm/route.ts");
  const getSource=source.slice(source.indexOf("export async function GET"),source.indexOf("export async function POST"));
  for(const mutation of ["seedUat(","runLeadReopening(","runSla(","enforceOps(","generateCommandReports(","runLeadCallbackSweep("]){
    assert.equal(getSource.includes(mutation),false,`GET must not invoke ${mutation}`);
  }
  assert.match(source,/action==="initialize_uat"/);
  assert.match(source,/requireUatSandbox\(\)/);
  assert.match(source,/PAWSPACE_PAYMENT_ENV\|\|""\)!=="sandbox"/);
  assert.match(source,/action==="run_callback_sweep"/);
});

test("live commercial quotes never infer Bengaluru when geography is absent",async()=>{
  const quotes=await read("lib/live-commercial-quotes.ts");
  const resolver=await read("lib/live-pricing-resolver.ts");
  assert.match(quotes,/resolveLiveBasePrice/);
  assert.match(quotes,/location\s*\?\s*await resolveLivePrice/);
  assert.doesNotMatch(quotes,/cityId:\s*input\.cityId\s*\?\?\s*["']blr["']/);
  assert.doesNotMatch(quotes,/zoneId:\s*input\.zoneId\s*\?\?\s*["']blr-east["']/);
  const baseFn=resolver.slice(resolver.indexOf("export async function resolveLiveBasePrice"));
  assert.match(baseFn,/SELECT base_price FROM service_packages/);
  assert.doesNotMatch(baseFn,/calculatePrice\(/);
});

test("new pricing, Haptik and Grooming finance inputs require explicit geography",async()=>{
  const pricingQuote=await read("app/api/pricing-quote/route.ts");
  const pricingControl=await read("app/api/pricing-control/route.ts");
  const haptik=await read("app/api/haptik/route.ts");
  const groomingFinance=await read("app/api/grooming-finance/route.ts");
  const boarding=await read("app/api/boarding-commercial/route.ts");
  assert.match(pricingQuote,/Package, scheduled start and city are required/);
  assert.doesNotMatch(pricingQuote,/body\.cityId\s*\?\?\s*"blr"/);
  assert.match(pricingControl,/including city are required/);
  assert.match(pricingControl,/city_id text NOT NULL/);
  assert.match(haptik,/City and zone are required to fetch serviceable Haptik slots/);
  assert.match(groomingFinance,/City is required for a Grooming tax policy/);
  assert.match(boarding,/availabilityMode:!hasLocation\?"location_required"/);
});

test("OTP identity creation never silently assigns Bengaluru",async()=>{
  const customer=await read("lib/customer-otp.ts");
  const partner=await read("lib/partner-otp.ts");
  assert.doesNotMatch(customer,/input\.cityId\|\|"blr"/);
  assert.match(customer,/text\(input\.cityId\)\|\|"unassigned"/);
  assert.match(customer,/cityId:text\(customer\.city_id\)&&text\(customer\.city_id\)!=="unassigned"\?text\(customer\.city_id\):null/);
  assert.doesNotMatch(partner,/input\.cityId\|\|"blr"/);
  assert.match(partner,/text\(input\.cityId\)\|\|null/);
});

test("prelaunch booking swarm is blocked outside the isolated UAT sandbox",async()=>{
  const auth=await read("lib/server-auth.ts");
  const swarm=await read("app/api/prelaunch-booking-swarm/route.ts");
  assert.match(swarm,/authorize\(request,"launch\.manage"\)/);
  assert.match(auth,/pathname==="\/api\/prelaunch-booking-swarm"/);
  assert.match(auth,/uatLoginEnabled\(uatEnv\)/);
  assert.match(auth,/PAWSPACE_PAYMENT_ENV\|\|""\)!=="sandbox"/);
  assert.match(auth,/Prelaunch swarm is available only in the isolated UAT sandbox/);
});
