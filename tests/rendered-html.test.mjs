import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(await response.text(), developmentPreviewMeta);
});

test("server-enforces privileged API access before route handlers", async () => {
  const [worker, gateway, security] = await Promise.all(
    ["worker/index.ts", "lib/api-gateway.ts", "lib/server-auth.ts"].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );
  assert.match(worker, /authorizeApiRequest/);
  assert.match(gateway, /Authentication required/);
  assert.match(gateway, /Access has not been provisioned or is disabled/);
  assert.match(gateway, /Cross-origin write blocked/);
  for (const permission of ["customers.manage", "finance.manage", "marketing.manage", "pricing.manage", "scheduling.manage", "launch.manage"]) assert.match(gateway, new RegExp(permission));
  assert.match(security, /FOUNDER_EMAIL/);
  assert.match(security, /security_audit_events/);
});

test("rejects an anonymous privileged API request at the worker boundary", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("security", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("https://pawspace.example/api/finance-control"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
});

test("renders the isolated 100-customer PawSpace test lab", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test-lab", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/test-lab", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /100 test customers/i);
  assert.match(html, /Zero live impact/i);
  assert.match(html, /Book once\. See every system react\./i);
  assert.match(html, /Confirm test booking/i);
});

test("wires the synthetic transaction engine into every operating surface", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("transaction-surfaces", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  // /admin, /ops and /account were fabricated dashboards and now redirect; the engine is checked
  // on the real surfaces that replaced them.
  for (const path of ["/", "/team", "/crm", "/partner-app"]) {
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /TEST TRANSACTION ENGINE/i, path);
  }
});

test("renders the 100-customer regression command centre", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("regression-lab", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/regression-lab", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Prove every workflow before production/i);
  assert.match(html, /1,000/);
  assert.match(html, /SYNTHETIC DATA ONLY/i);
  assert.match(html, /External integrations/i);
});

test("mobile-app SSR shell never leaks real booking content before the client-side login gate resolves", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("mobile-app", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/mobile-app", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  // The login gate is a client-side session check (useEffect), so the raw SSR shell is
  // intentionally blank until hydration confirms a real session - it must never leak real
  // booking-app content (service catalogue, wallet balance, pet history) to an unauthenticated
  // request, even transiently.
  assert.doesNotMatch(html, /PawCare Wallet/i);
  assert.doesNotMatch(html, /Eight care services/i);
  assert.match(html, /<html/i);
});

test("renders the connected Booking Command Center", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("booking-command-center", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/booking-command-center", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Booking Command Center/i);
  assert.match(html, /One place to control every booking/i);
  const [page, api, admin] = await Promise.all(["app/booking-command-center/page.tsx", "app/api/booking-command-center/route.ts", "app/team/page.tsx"].map(path => readFile(new URL("../" + path, import.meta.url), "utf8")));
  assert.match(page, /Tickets & refunds/);
  assert.match(page, /UNIFIED ORDER TIMELINE/);
  assert.match(api, /canonical_bookings/);
  assert.match(api, /booking_admin_actions/);
  assert.match(admin, /\/team\/operations\/bookings/); // the real Team front door links to the Command Center
});

test("renders the evidence-based System Integration Control", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("system-integration", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
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

  assert.match(mobileHome, /PAWSPACE MEDIA/);
  assert.match(mobileHome, /TRAINING VIDEO/);
  assert.match(mobileHome, /PawSpace Media slot/);
  assert.match(stays, /nights > 4/);
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
  // Delay recovery moved from the retired /groomer prototype (which sent hardcoded booking IDs) to
  // the real Partner App, where it runs against the selected canonical booking.
  const [grooming, training, stays, groomer, operations, schema] = await Promise.all(
    ["app/mobile-app/grooming-flow.tsx", "app/mobile-app/training-flow.tsx", "app/mobile-app/stay-flow.tsx", "app/partner-app/page.tsx", "app/api/booking-operations/route.ts", "db/schema.ts"].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
  );
  assert.ok(grooming.indexOf("Pay after service") < grooming.indexOf("Verify OTP & confirm instantly"));
  assert.match(training, /Meet the trainer first\. Book only when you feel confident/);
  assert.match(training, /Book only the Meet & Greet/);
  assert.match(stays, /10-minute phone call · Included/);
  assert.match(groomer, /Package upgraded/);
  assert.match(groomer, /Bike issue/);
  assert.match(groomer, /Open protected rebooking/);
  assert.match(operations, /impactedBookings/);
  assert.match(operations, /booking_customer_notifications/);
  assert.match(operations, /booking_refund_cases/);
  assert.match(operations, /Refund cannot move from/);
  assert.match(schema, /bookingOperationalEvents/);
  assert.match(schema, /bookingRebookingCases/);
});

test("uses 60 minutes per training pet and one GPS policy for doorstep providers", async () => {
  const [training, trainer, tracking, grooming, stays] = await Promise.all(
    ["app/mobile-app/training-flow.tsx", "app/trainer/page.tsx", "app/mobile-app/provider-tracking-card.tsx", "app/mobile-app/grooming-flow.tsx", "app/mobile-app/stay-flow.tsx"].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );
  assert.match(training, /serviceMinutes=selectedPets\.length\*\(plan\.directMinutes\+plan\.coachingMinutes\)/);
  assert.match(training, /Every pet has one paid \{plan\.directMinutes\+plan\.coachingMinutes\}-minute session/);
  assert.match(trainer, /loadTrainerSessions/);
  assert.match(trainer, /selected.total_sessions/);
  assert.match(tracking, /Tracking starts when the/);
  assert.match(tracking, /Primary and secondary contacts/);
  assert.match(grooming, /role="Groomer"/);
  assert.match(training, /loadTrainingTrainers/);
  assert.match(training, /confirmedTrainerName/);
  assert.match(stays, /role="Sitter"/);
});

test("keeps coupon and referral management as separate full control modules", async () => {
  const [control, coupons, referrals] = await Promise.all(
    ["app/control/page.tsx", "app/control/coupons-control-panel.tsx", "app/control/referrals-control-panel.tsx"].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );
  assert.match(control, /Coupon management/);
  assert.match(control, /Referral management/);
  assert.match(coupons, /Create coupon/);
  assert.match(coupons, /Cross-sell source/);
  assert.match(coupons, /City availability/);
  assert.match(coupons, /Booking channels/);
  assert.match(referrals, /Referral & reward ledger/);
  assert.match(referrals, /Fraud controls/);
  assert.match(referrals, /Reward lifecycle/);
});

test("provides a city geofence and city price-book launch control", async () => {
  const [control, cities] = await Promise.all(
    ["app/control/page.tsx", "app/control/city-control-panel.tsx"].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );
  assert.match(control, /Cities & geofences/);
  assert.match(control, /Geofence \+ city price book/);
  assert.match(cities, /Add new city/);
  assert.match(cities, /Coverage radius/);
  assert.match(cities, /Serviceable pincodes/);
  assert.match(cities, /CITY PRICE BOOK/);
  assert.match(cities, /Prices include GST/);
  assert.match(cities, /Draft → validate coverage & prices → owner approval → city goes live/);
});

test("provides governed package, slot and dynamic pricing controls", async () => {
  const [control, panel, engine, schema, quote] = await Promise.all(
    ["app/control/page.tsx", "app/control/pricing-control-panel.tsx", "lib/pricing-engine.ts", "db/schema.ts", "app/api/pricing-quote/route.ts"].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
  );
  assert.match(control, /Pricing, packages & slots/);
  assert.match(panel, /Packages & slots/);
  assert.match(panel, /Dynamic price rules/);
  assert.match(panel, /Compare with TEST10 coupon/);
  assert.match(panel, /Training/);
  assert.match(panel, /Boarding/);
  assert.match(panel, /Pet Sitting/);
  assert.match(engine, /priceBeforeCoupon/);
  assert.match(engine, /couponStatus/);
  assert.match(schema, /dynamic_pricing_rules/);
  assert.match(schema, /pricing_audit_events/);
  assert.match(quote, /calculatePrice/);
});

test("provides an end-to-end governed marketing command center", async () => {
  const [control, panel, route, schema] = await Promise.all(
    ["app/control/page.tsx", "app/control/marketing-control-panel.tsx", "app/api/marketing-control/route.ts", "db/schema.ts"].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
  );
  assert.match(control, /Marketing command center/);
  assert.match(panel, /Spend with proof\. Promote with control\./);
  assert.match(panel, /Google Ads/);
  assert.match(panel, /Meta Ads/);
  assert.match(panel, /Unit economics/);
  assert.match(panel, /Incremental \/ holdout/);
  assert.match(panel, /AI & automation/);
  assert.match(panel, /Select the reporting range/);
  assert.match(route, /marketing_campaigns/);
  assert.match(route, /human_approval/);
  assert.match(schema, /marketingPromotions/);
  assert.match(schema, /marketingAuditEvents/);
});

test("provides a unified finance, expenses and accounting command center", async () => {
  const [control, panel, route, schema] = await Promise.all(
    ["app/control/page.tsx", "app/control/finance-control-panel.tsx", "app/api/finance-control/route.ts", "db/schema.ts"].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
  );
  assert.match(control, /Finance, expenses & accounts/);
  for (const view of ["Overview", "Expenses", "Purchase & payables", "Collections", "Settlements", "Ledger", "GST & TDS", "Banking", "Budgets", "Intelligence", "Period close"]) assert.match(panel, new RegExp(view.replace(/[&]/g, "\\&")));
  assert.match(panel, /Maker cannot approve their own transaction/);
  assert.match(panel, /Double-entry control/);
  assert.match(panel, /Duplicate bill risk/);
  assert.match(panel, /Cash-flow forecast/i);
  assert.match(panel, /Tally \/ Zoho Books/);
  assert.match(route, /finance_journal_entries/);
  assert.match(route, /debits.*credits/is);
  assert.match(route, /period_locked/);
  assert.match(schema, /financeExpenses/);
  assert.match(schema, /financeClosePeriods/);
  assert.match(schema, /financeAuditEvents/);
});

test("provides governed launch gates, UAT evidence and an exception queue", async () => {
  const [control, panel, route, schema] = await Promise.all(
    ["app/control/page.tsx", "app/control/launch-readiness-panel.tsx", "app/api/launch-readiness/route.ts", "db/schema.ts"].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
  );
  assert.match(control, /Launch essentials/);
  assert.match(panel, /Close basics with evidence, not confidence/);
  assert.match(panel, /UAT sign-off/);
  assert.match(panel, /Exception queue/);
  assert.match(route, /Authentication required/);
  assert.match(route, /Evidence is required before verification/);
  assert.match(route, /p0Verified/);
  assert.match(schema, /launchReadinessItems/);
  assert.match(schema, /operationalExceptions/);
});

test("provides protected customer import, configurable roles and routed contact actions", async () => {
  const [control, access, customerData, governance, importer, contact, security] = await Promise.all(
    [
      "app/control/page.tsx",
      "app/control/access-control-panel.tsx",
      "app/control/customer-data-panel.tsx",
      "app/api/platform-governance/route.ts",
      "app/api/subscription-customers/route.ts",
      "app/api/customer-contact/route.ts",
      "lib/platform-security.ts",
    ].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
  );
  assert.match(control, /Users, roles & access/);
  assert.match(control, /Customer data & contact/);
  // Was: /Founder permissions cannot be downgraded/ on the access panel. That named founder alone
  // while the panel offered superuser — also ["*"] — in both role dropdowns, and claimed a permission
  // editor that did not exist. Protection is now derived from permissions.
  assert.match(access, /isFullAccessRole/, "the panel must derive protection from permissions, not a role name");
  assert.match(access, /assignableRoles/, "and offer only roles it is permitted to assign");
  assert.match(access, /Create user/);
  assert.match(customerData, /Import protected customer data/);
  assert.match(customerData, /Call primary/);
  assert.match(customerData, /Try secondary/);
  assert.match(governance, /create_user/);
  assert.match(governance, /isFullAccessRole/, "the route must derive the protected set from permissions");
  assert.match(importer, /ON CONFLICT\(customer_key\)/);
  assert.match(contact, /enqueueCommunication/);
  assert.match(contact, /governed_outbox/);
  assert.match(contact, /provider:"not_dispatched"/);
  assert.doesNotMatch(contact, /EXOTEL_API_KEY/);
  assert.match(contact, /nextFallback/);
  for (const role of ["founder", "superuser", "admin", "manager", "associate", "service_provider", "finance", "auditor"]) assert.match(security, new RegExp(`code:\\"${role}\\"`));
});

test("persists one canonical customer-to-payment lifecycle across all four journeys", async () => {
  const [control,panel,route,schema,grooming,training,stays,gateway] = await Promise.all(
    ["app/control/page.tsx","app/control/booking-lifecycle-panel.tsx","app/api/canonical-bookings/route.ts","db/schema.ts","app/mobile-app/grooming-flow.tsx","app/mobile-app/training-flow.tsx","app/mobile-app/stay-flow.tsx","lib/api-gateway.ts"].map((path)=>readFile(new URL("../"+path,import.meta.url),"utf8")),
  );
  assert.match(control,/Customer booking lifecycle/);
  assert.match(panel,/One booking ID\. Every operating record linked\./);
  assert.match(panel,/UAT sandbox payments only/);
  for(const table of ["canonical_customers","canonical_pets","canonical_bookings","provider_work_orders","booking_payments","booking_lifecycle_events"])assert.match(route,new RegExp(table));
  assert.match(route,/Scheduling must be assigned before booking confirmation/);
  assert.match(route,/duplicatePrevented/);
  for(const model of ["canonicalCustomers","canonicalPets","canonicalBookings","providerWorkOrders","bookingPayments","bookingLifecycleEvents"])assert.match(schema,new RegExp(model));
  for(const flow of [grooming,training,stays])assert.match(flow,/createCanonicalLifecycle/);
  assert.match(stays,/serviceCode:mode==="boarding"\?"boarding":"pet_sitting"/);
  assert.match(gateway,/canonical-bookings/);
});

test("supports configurable requirements and contained training plan cards", async () => {
  const [training, styles, planStyles, control, route, client] = await Promise.all(
    [
      "app/mobile-app/training-flow.tsx",
      "app/mobile-app/training.module.css",
      "app/mobile-app/training-plans.module.css",
      "app/control/pricing-control-panel.tsx",
      "app/api/training-requirements/route.ts",
      "lib/canonical-lifecycle-client.ts",
    ].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
  );
  assert.match(training, /Add another requirement/);
  assert.match(training, /aria-pressed/);
  assert.match(training, /requirements:selectedGoals/);
  assert.match(training, /planStyles\.selected/);
  assert.match(training, /role="button"/);
  assert.match(training, /Select this programme/);
  assert.match(styles, /button\.selected/);
  assert.match(styles, /box-shadow/);
  assert.match(planStyles, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(planStyles, /\.selected/);
  assert.match(planStyles, /\.metrics/);
  assert.match(control, /Training requirements/);
  assert.match(control, /Add, rename or pause/);
  assert.match(route, /training_requirements/);
  assert.match(client, /requirements\?:string\[\]/);
});

test("provides one governed business, accounts, customer and report centre", async () => {
  const [control, business, schema] = await Promise.all(
    ["app/control/page.tsx", "app/control/business-intelligence-panel.tsx", "db/schema.ts"].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );
  assert.match(control, /Business 360 & reports/);
  assert.match(business, /One number, every vertical, down to the customer/);
  for (const view of ["Overview", "Verticals", "Accounts", "Customers", "Subscriptions", "Reports"]) assert.match(business, new RegExp(`\\"${view}\\"`));
  assert.match(business, /Old customer win-back/);
  assert.match(business, /Real customer 360 - orders, revenue, subscription-aware segment and risk/);
  for (const format of ["CSV", "Excel", "PDF", "JSON"]) assert.match(business, new RegExp(`\\"${format}\\"`));
  assert.match(business, /Create a customer or management report/);
  assert.match(business, /Google Sheets/);
  assert.match(business, /Google Docs/);
  assert.match(business, /Integration-ready/);
  assert.match(business, /Email attachment/);
  assert.match(business, /Select the report date range/);
  assert.match(business, /From date/);
  assert.match(business, /To date/);
  assert.match(business, /Date based on/);
  assert.match(business, /Customer created date/);
  assert.match(business, /Customer Created Date column/);
  assert.match(business, /Define the scheduled reporting period/);
  assert.match(business, /Role permission · masking · purpose/);
  assert.match(schema, /businessMetricDefinitions/);
  assert.match(schema, /reportDefinitions/);
  assert.match(schema, /reportRuns/);
});

test("publishes an evidence-based full-platform audit without false production health claims", async () => {
  const [control, audit] = await Promise.all(
    ["app/control/page.tsx", "app/control/platform-audit-panel.tsx"].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );
  assert.match(control, /Platform audit & release/);
  assert.match(control, /Auto-scheduling/);
  assert.match(control, /Build healthy · production telemetry not connected/);
  assert.doesNotMatch(control, /99\.94% healthy/);
  for (const area of ["Customer app", "Provider apps", "CRM & sales", "Operations & dispatch", "HR", "Payroll", "Finance & accounts", "Security & privacy", "AI & automation", "Reliability & release"]) assert.match(audit, new RegExp(area));
  for (const status of ["Verified prototype", "Partial", "Integration-ready", "Missing core"]) assert.match(audit, new RegExp(status));
  assert.match(audit, /Current release decision/);
  assert.match(audit, /not yet approved for unattended public production traffic/i);
  assert.match(audit, /Access configuration and UAT/);
  assert.match(audit, /Backup and recovery proof/);
  assert.match(audit, /SAFE AUTOMATION ORDER/);
  assert.match(audit, /Salesforce Sales Cloud/);
  assert.match(audit, /Dynamics 365 Field Service/);
  assert.match(audit, /India DPDP Rules 2025/);
});

test("runs a persistent Revenue 100, lead SLA, RNR and customer-ticket foundation", async () => {
  const [crm, panel, route, schema, migration] = await Promise.all(
    ["app/crm/page.tsx","app/crm/revenue-engine-panel.tsx","app/api/revenue-crm/route.ts","db/schema.ts","drizzle/0013_demonic_umar.sql"].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );
  assert.match(crm, /Revenue & CX engine/);
  assert.match(panel, /Today’s 100 best revenue actions/);
  assert.match(panel, /10-MINUTE ACTION · 30-MINUTE ESCALATION/);
  assert.match(panel, /Four calls \+ four WhatsApp attempts/);
  assert.match(panel, /Tickets, refunds and escalations/);
  assert.match(panel, /WATI, SMS and calling actions remain UAT-queued/);
  assert.match(route, /generateDaily100/);
  assert.match(route, /Four .* attempts are already recorded/);
  assert.match(route, /Cold requires 4 calls, 4 WhatsApp attempts and three working days/);
  assert.match(route, /30-minute lead response breached/);
  assert.match(route, /Resolution, root cause and evidence are mandatory/);
  for (const model of ["revenueOpportunities","leadWorkItems","leadAttempts","customerExperienceTickets","crmEngineAuditEvents"]) assert.match(schema, new RegExp(model));
  for (const table of ["revenue_opportunities","lead_work_items","lead_attempts","customer_experience_tickets","crm_engine_audit_events"]) assert.match(migration, new RegExp(table));
});

test("closes the revenue engine with reopening, incentives, reporting, accounts and ops enforcement", async () => {
  const [panel, route, schema] = await Promise.all(
    ["app/crm/revenue-engine-panel.tsx", "app/api/revenue-crm/route.ts", "db/schema.ts"].map((path) =>
      readFile(new URL("../" + path, import.meta.url), "utf8"),
    ),
  );
  assert.match(panel, /30\/60\/90-DAY REOPENING/);
  assert.match(panel, /Sales incentives and live leaderboard/);
  assert.match(panel, /AUTOMATED 7 PM REPORTS/);
  assert.match(panel, /MANDATORY ACCOUNTS CLOSE/);
  assert.match(panel, /OPS COMPLETION ENFORCEMENT/);
  assert.match(panel, /WATI, SMS and telephony control/);
  assert.match(route, /runLeadReopening/);
  assert.match(route, /All six Accounts checks are mandatory/);
  assert.match(route, /Evidence, customer update, payment confirmation and settlement readiness are mandatory/);
  for (const model of ["leadReopenEvents", "communicationDeliveryEvents", "salesPerformanceDaily", "commandReportRuns", "financeDayClosures", "opsCompletionControls"]) assert.match(schema, new RegExp(model));
});

test("consolidates PawSpace into four role-based entry points", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("four-experiences", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  for (const path of ["/", "/partner", "/team", "/control", "/team/sales", "/team/operations", "/team/operations/bookings", "/team/finance", "/control/integrations"]) {
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 200, path);
  }
  const team = await readFile(new URL("../app/team/page.tsx", import.meta.url), "utf8");
  for (const title of ["Revenue & CRM", "Bookings & delivery", "Tickets & recovery", "Accounts & collections", "HR & performance", "Segments & campaigns"]) assert.match(team, new RegExp(title));
  assert.match(team, /6 teams · 1 customer record · 1 audit trail/);
});
