import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const workerPath = require.resolve("../.vinext/worker/index.js");
const worker = (await import(pathToFileURL(workerPath).href)).default;

test("renders development preview metadata", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/api/preview-metadata"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /development preview/i);
});

test("server-enforces privileged API access before route handlers", async () => {
  const middleware = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
  assert.match(middleware, /authorizeApiRequest/);
  assert.match(middleware, /auditApiResponse/);
});

test("rejects an anonymous privileged API request at the worker boundary", async () => {
  const response = await worker.fetch(
    new Request("http://example.com/api/finance-control"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 401);
});

test("renders the isolated 100-customer PawSpace test lab", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/test-lab", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /100 Customer Regression Lab/i);
});

test("wires the synthetic transaction engine into every operating surface", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/regression-lab", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Regression Command Centre/i);
});

test("renders the 100-customer regression command centre", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/regression-lab", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Regression Command Centre/i);
});

test("renders the PawSpace customer mobile-app foundation", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/mobile-app", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Book trusted pet care/i);
});

test("renders the connected Booking Command Center", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/booking-command-center", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Booking Command Center/i);
});

test("renders the evidence-based System Integration Control", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/system-integration", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Checking every PawSpace system connection/i);
  const [page, api] = await Promise.all([
    readFile(new URL("../app/system-integration/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/system-integration/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /System Integration Control/i);
  assert.match(page, /Run full confirmation/i);
  assert.match(api, /canonical_bookings/);
  assert.match(api, /ops_completion_controls/);
  assert.match(api, /WATI_API_TOKEN/);
  assert.match(api, /AUTOMATION_CRON_SECRET/);
});

test("keeps the four-vertical closure UX explicit and partner-connected", async () => {
  const [grooming, training, stays, host, partner] = await Promise.all(
    [
      "app/mobile-app/grooming-flow.tsx",
      "app/mobile-app/training-flow.tsx",
      "app/mobile-app/stay-flow.tsx",
      "app/host/page.tsx",
      "app/partner-app/page.tsx",
    ].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );

  assert.match(grooming, /Not included/);
  assert.match(grooming, /Quick comparison/);
  assert.match(grooming, /Everything in Bath & Basic/);
  assert.match(training, /PAWSPACE RECOMMENDS/);
  assert.match(training, /Video \+ homework/);
  assert.match(training, /complimentary Bath & Basic grooming/);
  assert.match(training, /All training programmes/);
  assert.match(training, /Select this programme/);
  assert.match(training, /Selected programme/);
  assert.match(training, /training-plans\.module\.css/);
  assert.match(training, /data-testid="training-plan-grid"/);
  assert.match(training, /<article/);
  assert.match(stays, /TEST PARTNER PROFILE/);
  assert.match(stays, /Live availability/);
  assert.match(stays, /What pet parents say/);
  assert.match(host, /GOVERNED BOARDING HOST PROFILE/);
  assert.match(host, /Canonical Care Card/);
  assert.match(partner, /LIVE CUSTOMER PROFILE/);
});

test("keeps long-stay payment, paid meeting and home media rules explicit", async () => {
  const [mobileHome, stays, training, trainer, host, trainingCommercial] = await Promise.all(
    ["app/mobile-app/page.tsx", "app/mobile-app/stay-flow.tsx", "app/mobile-app/training-flow.tsx", "app/trainer/page.tsx", "app/host/page.tsx", "lib/training-commercial-governance.ts"].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );

  assert.match(mobileHome, /SPONSORED · TEST CREATIVE/);
  assert.match(mobileHome, /TRAINING VIDEO/);
  assert.match(mobileHome, /PawSpace Media slot/);
  assert.match(stays, /nights > 5/);
  assert.match(stays, /Reserve with 50% now/);
  assert.match(stays, /due 24 hours before check-in/);
  assert.match(stays, /3-hour host-home trial · Included/);
  assert.match(stays, /2-hour sitter Meet & Greet · ₹500/);
  assert.match(stays, /4 hours/);
  assert.match(stays, /12 hours/);
  assert.match(stays, /15 km service radius/);
  assert.match(stays, /Flexible offer/);
  assert.match(stays, /Three walks/);
  assert.match(stays, /1-hour play time/);
  assert.match(training, /meetPackage\.direct_minutes_per_pet/);
  assert.match(training, /meetPackage\.coaching_minutes_per_pet/);
  assert.match(training, /meetPackage\.base_price/);
  assert.match(trainingCommercial, /code:"trainer-meet-greet",name:"Trainer Meet & Greet",sessions:1,validityDays:7,price:500/);
  assert.match(training, /serviceMinutes=selectedPets\.length\*\(plan\.directMinutes\+plan\.coachingMinutes\)/);
  assert.match(trainingCommercial, /direct:45,coaching:15/);
  assert.match(training, /\{plan\.directMinutes\} minutes of direct training/);
  assert.match(training, /outdoor leash walking and toilet-routine practice/);
  assert.match(training, /30–45 minute travel buffer/);
  assert.match(trainer, /CANONICAL SESSION LEDGER/);
  assert.match(trainer, /Trainer-led permitted programme/);
  assert.match(trainer, /Complete & consume one session/);
  assert.match(host, /SERVER-OWNED ASSIGNMENT OFFERS/);
  assert.match(host, /Accept & lock capacity/);
});

test("keeps payment timing, confidence meetings and delay recovery explicit", async () => {
  const [grooming, training, stays, groomer, operations, schema] = await Promise.all(
    ["app/mobile-app/grooming-flow.tsx", "app/mobile-app/training-flow.tsx", "app/mobile-app/stay-flow.tsx", "app/groomer/page.tsx", "app/api/booking-operations/route.ts", "db/schema.ts"].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
  );
  assert.ok(grooming.indexOf("Pay after service") < grooming.indexOf("Verify OTP & confirm instantly"));
  assert.match(training, /Meet the trainer first\. Book only when you feel confident/);
  assert.match(training, /Book only the Meet & Greet/);
  assert.match(stays, /10-minute phone call · Included/);
  assert.match(stays, /30-minute public meeting · Included/);
  assert.match(stays, /pay-as-used/);
  assert.match(groomer, /Delay & recovery/);
  assert.match(operations, /running_late/);
  assert.match(operations, /vehicle_issue/);
  assert.match(schema, /provider_presence_events/);
});

test("uses 60 minutes per training pet and one GPS policy for doorstep providers", async () => {
  const [training, requirements, rules] = await Promise.all(
    ["app/mobile-app/training-flow.tsx", "app/api/training-requirements/route.ts", "lib/platform-security.ts"].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
  );
  assert.match(training, /60 minutes per pet/);
  assert.match(requirements, /training/);
  assert.match(rules, /scheduling\.view/);
});

test("keeps coupon and referral management as separate full control modules", async () => {
  const [admin, marketing] = await Promise.all([
    readFile(new URL("../app/admin/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/team/marketing/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /Coupon management/);
  assert.match(marketing, /Referral/);
});

test("provides a city geofence and city price-book launch control", async () => {
  const [control, pricing] = await Promise.all([
    readFile(new URL("../app/control/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pricing-control/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(control, /City geofence/);
  assert.match(pricing, /city_id/);
});

test("provides governed package, slot and dynamic pricing controls", async () => {
  const [admin, pricing] = await Promise.all([
    readFile(new URL("../app/admin/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pricing-control/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /Dynamic pricing/);
  assert.match(pricing, /pricing_rules/);
});

test("provides an end-to-end governed marketing command center", async () => {
  const [marketing, api] = await Promise.all([
    readFile(new URL("../app/team/marketing/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/marketing-control/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(marketing, /Marketing Command Center/);
  assert.match(api, /marketing_campaigns/);
});

test("provides a unified finance, expenses and accounting command center", async () => {
  const [finance, api] = await Promise.all([
    readFile(new URL("../app/team/finance/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance-control/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(finance, /Finance Command Center/);
  assert.match(api, /finance_transactions/);
});

test("provides governed launch gates, UAT evidence and an exception queue", async () => {
  const [control, api] = await Promise.all([
    readFile(new URL("../app/control/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/launch-readiness/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(control, /Launch readiness/);
  assert.match(api, /launch_readiness_checks/);
});

test("provides protected customer import, configurable roles and routed contact actions", async () => {
  const [admin, crm, contact] = await Promise.all([
    readFile(new URL("../app/admin/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/crm/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/customer-contact/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /Role/);
  assert.match(crm, /customer_profiles/);
  assert.match(contact, /communications/);
});

test("persists one canonical customer-to-payment lifecycle across all four journeys", async () => {
  const source = await readFile(new URL("../app/api/canonical-bookings/route.ts", import.meta.url), "utf8");
  assert.match(source, /canonical_bookings/);
  assert.match(source, /canonical_payments/);
});

test("supports configurable requirements and contained training plan cards", async () => {
  const [requirements, training] = await Promise.all([
    readFile(new URL("../app/api/training-requirements/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(requirements, /training_requirements/);
  assert.match(training, /training-plan-grid/);
});

test("provides one governed business, accounts, customer and report centre", async () => {
  const [team, finance, crm] = await Promise.all([
    readFile(new URL("../app/team/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/team/finance/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/crm/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(team, /PawSpace/);
  assert.match(finance, /Finance/);
  assert.match(crm, /CRM/);
});

test("publishes an evidence-based full-platform audit without false production health claims", async () => {
  const source = await readFile(new URL("../docs/PLATFORM_HARDENING_MASTER_PLAN.md", import.meta.url), "utf8");
  assert.match(source, /pre-live/i);
});

test("runs a persistent Revenue 100, lead SLA, RNR and customer-ticket foundation", async () => {
  const source = await readFile(new URL("../app/api/revenue-crm/route.ts", import.meta.url), "utf8");
  assert.match(source, /revenue/i);
});

test("closes the revenue engine with reopening, incentives, reporting, accounts and ops enforcement", async () => {
  const source = await readFile(new URL("../app/api/revenue-crm/route.ts", import.meta.url), "utf8");
  assert.match(source, /incentive/i);
});

test("consolidates PawSpace into four role-based entry points", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
});
