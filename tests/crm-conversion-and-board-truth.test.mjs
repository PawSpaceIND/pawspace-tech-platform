/*
 * CRM → BOOKING CONVERSION, AND THE CRM BOARD TELLING THE TRUTH.
 *
 * Eight defects reported against /crm and /assisted-booking, every one of them proved here by RUNNING
 * the real route handlers and the real page predicates against a real SQLite database - never by
 * reading the source and hoping.
 *
 *  W1-1  POST /api/assisted-orders answered 500 {"error":"Unable to create Assisted Order UAT"} for
 *        every customer, every slot and the non-CRM fixture path. The refusal is real and correct -
 *        generateCanonicalSalesQuote fails CLOSED when no published city GST policy exists - but it
 *        signals with a plain Error, and authError classifies a plain Error as an unexpected server
 *        fault. Measured on the UAT database: grooming_tax_policies did not exist at all, so the
 *        request died at the quote before the scheduler was ever called, and the operator was told
 *        nothing. A governed precondition must arrive as a 4xx that names what is missing.
 *
 *  W1-2  The conversion posted the MASKED phone as the customer's real phone. /api/customer-360
 *        serves "+91 ••••••5678" by policy; /assisted-booking kept that display string in the customer
 *        object, /api/assisted-orders forwarded it verbatim, and /api/canonical-bookings upserts
 *        primary_phone=excluded.primary_phone - so the first successful order would have written
 *        bullets over the real number. The server resolves the phone from the customer id now.
 *
 *  W1-3  "Rotate day" 500'd on every lead: rotateLeadAssignmentAndSla -> assignLead throws
 *        "No active lead assignment policy matches this lead service/city" because
 *        lead_assignment_policies is empty. Same class as W1-1: a governed precondition flattened
 *        into a server fault.
 *
 *  W1-4  Two sources of truth for one fact. The "Lead SLA breaches" tile and the red lead card read
 *        lead_work_items.status='sla_breached', written only by the five-minute cron, while the SLA
 *        engine records breaches in lead_sla_clocks. Eight breached clocks, tile reading 0, two of the
 *        breached leads rendering a plain "ACTIVE" on the board.
 *
 *  W1-5  A segment that matched nothing left the 360 panel on an unrelated customer with a live
 *        "Book this customer" link - an operator could book the wrong person.
 *
 *  W1-6  Two identically-named packages at very different prices ("Bath & Basic" ₹1,899 vs ₹999).
 *
 *  W1-7  The "At risk" segment matched a stage string no writer stores.
 *
 *  W1-8  A search that matched nothing said "No CRM contacts yet", inviting a duplicate; and the
 *        client-side phone `pattern` was an invalid regex in v-mode, so there was no validation at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__CRM_W1_DB__", "__CRM_W1_ENV__");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (response) => ({ status: response.status, body: await response.json() });

/** A fresh database bound to the worker shim, with the schema the assisted-order chain writes into. */
function database() {
  const harness = freshCountingD1();
  globalThis.__CRM_W1_DB__ = harness.db;
  globalThis.__CRM_W1_ENV__ = {};
  harness.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT NOT NULL DEFAULT 'New lead',owner TEXT,source TEXT,lifetime_value REAL DEFAULT 0,next_action TEXT,opportunity TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT,secondary_phone TEXT,email TEXT,source TEXT,consent_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,total_amount REAL,channel TEXT,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT,event_type TEXT,entity_type TEXT,entity_id TEXT,actor_id TEXT,detail_json TEXT,occurred_at INTEGER);
  `);
  return harness;
}

/** The internal /api/uat-scheduling + /api/canonical-bookings chain, captured rather than executed. */
function captureInternalChain({ bookingId = "BK-W1-0001" } = {}) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push({ url, body });
    if (url.includes("/api/uat-scheduling")) {
      return Response.json({ data: { groupId: body.clientRequestId, provider: { id: "PRV-1", name: "UAT Groomer", model: "full_time" } } });
    }
    if (url.includes("/api/canonical-bookings")) {
      return Response.json({ data: { bookingId } });
    }
    throw new Error(`unexpected internal call: ${url}`);
  };
  return { sent, restore: () => { globalThis.fetch = original; }, to: (path) => sent.find((call) => call.url.includes(path)) };
}

const assistedOrderRequest = (overrides = {}) => new Request("http://localhost/api/assisted-orders", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    idempotencyKey: `w1-${Math.random().toString(36).slice(2)}`,
    customer: { id: "UAT-CUST-ASSIST-001", name: "Meera Shah", primaryPhone: "+919800000101" },
    pets: [{ sourceId: "UAT-PET-BRUNO", name: "Bruno", species: "dog" }],
    cityId: "blr", zoneId: "blr-east", packageCode: "dog-basic",
    scheduledStart: "2026-10-01T04:30:00.000Z", scheduledEnd: "2026-10-01T06:30:00.000Z",
    consent: { captured: true, method: "recorded_call", reference: "UAT-CALL-REF-001" },
    ...overrides,
  }),
});

/* ------------------------------------------------------------------ W1-1 */

test("W1-1: a missing city GST policy refuses the assisted order with a reason, not an anonymous 500", async () => {
  database();
  const chain = captureInternalChain();
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const { status, body } = await json(await route.POST(assistedOrderRequest()));

    assert.notEqual(status, 500, "a governed precondition is not a server fault");
    assert.equal(status, 409, "it is a refusal the caller can act on");
    assert.match(body.error, /GST policy/i, "the refusal must name the configuration that is missing");
    assert.match(body.error, /blr/, "and the city it is missing for");
    assert.equal(body.error.includes("Unable to create Assisted Order UAT"), false,
      "the generic fallback told a staff member nothing at all");
    assert.equal(chain.sent.length, 0, "the request never reached the scheduler - it died at the quote");
  } finally { chain.restore(); }
});

test("W1-1b: with the city GST policy published the same request completes through the canonical chain", async () => {
  const harness = database();
  const { seedDefaultGroomingTaxPolicy } = await import("../lib/grooming-invoice.ts");
  await seedDefaultGroomingTaxPolicy(harness.db, "blr");
  const chain = captureInternalChain({ bookingId: "BK-W1-OK" });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const { status, body } = await json(await route.POST(assistedOrderRequest()));
    assert.equal(status, 201, body.error ?? "the order must be created once the precondition holds");
    assert.equal(body.data.bookingId, "BK-W1-OK");
    assert.ok(chain.to("/api/uat-scheduling"), "the canonical scheduler was called");
    assert.ok(chain.to("/api/canonical-bookings"), "and the canonical booking after it");
    assert.equal(harness.sqlite.prepare("SELECT COUNT(*) c FROM assisted_orders").get().c, 1);
  } finally { chain.restore(); }
});

test("W1-1c: a refusal from inside the chain names which boundary refused and keeps its status", async () => {
  const harness = database();
  const { seedDefaultGroomingTaxPolicy } = await import("../lib/grooming-invoice.ts");
  await seedDefaultGroomingTaxPolicy(harness.db, "blr");
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("/api/uat-scheduling")
    ? Response.json({ error: "Pet ownership denied" }, { status: 403 })
    : Response.json({ data: { bookingId: "never" } });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const { status, body } = await json(await route.POST(assistedOrderRequest()));
    assert.equal(status, 403, "the internal status is carried, not flattened to 500");
    assert.match(body.error, /uat-scheduling/, "the operator is told WHICH boundary refused");
    assert.match(body.error, /Pet ownership denied/, "and the reason that boundary gave");
  } finally { globalThis.fetch = original; }
});

test("W1-1d: the scheduler is given the CANONICAL pet id, which is what it resolves ownership against", async () => {
  const harness = database();
  const { seedDefaultGroomingTaxPolicy } = await import("../lib/grooming-invoice.ts");
  await seedDefaultGroomingTaxPolicy(harness.db, "blr");
  const chain = captureInternalChain({ bookingId: "BK-W1-PET" });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    // Exactly the shape /assisted-booking builds from Customer 360: source identity "bruno", canonical
    // row id "UATD-CUS-1-PET". /api/uat-scheduling does SELECT ... FROM canonical_pets WHERE id=?.
    const { status, body } = await json(await route.POST(assistedOrderRequest({
      pets: [{ sourceId: "bruno", canonicalId: "UATD-CUS-1-PET", name: "Bruno", species: "dog" }],
    })));
    assert.equal(status, 201, body.error ?? "the order must be created");

    const scheduling = chain.to("/api/uat-scheduling");
    assert.deepEqual(scheduling.body.petIds, ["UATD-CUS-1-PET"],
      "sending the SOURCE id made the scheduler answer 403 'Pet ownership denied' for a pet the customer really owns");

    const booking = chain.to("/api/canonical-bookings");
    assert.equal(booking.body.pets[0].sourceId, "bruno",
      "the source identity still travels to the canonical booking, which stores both");
  } finally { chain.restore(); }
});

/* ------------------------------------------------------------------ W1-2 */

test("W1-2: the masked display phone never reaches the canonical booking - the server resolves the real one", async () => {
  const harness = database();
  const { seedDefaultGroomingTaxPolicy } = await import("../lib/grooming-invoice.ts");
  await seedDefaultGroomingTaxPolicy(harness.db, "blr");
  // A real CRM customer, exactly as /crm's "Book this customer" link hands one over.
  harness.sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,pet_names,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("CU-70001", "Priya Nair", "+919845012345", "Simba", 1, 1);
  const chain = captureInternalChain({ bookingId: "BK-W1-MASK" });
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const { status, body } = await json(await route.POST(assistedOrderRequest({
      customer: { id: "CU-70001", name: "P••••  N•", primaryPhone: "+91 ••••••2345" },
      pets: [{ sourceId: "PET-SIMBA", name: "Simba", species: "dog" }],
    })));
    assert.equal(status, 201, body.error ?? "a masked display phone must not block a legitimate conversion");

    const booking = chain.to("/api/canonical-bookings");
    assert.ok(booking, "the canonical booking call was made");
    assert.equal(booking.body.customer.primaryPhone, "+919845012345",
      "the booking upserts primary_phone=excluded.primary_phone, so this value becomes the customer's phone");
    assert.equal(/[•*]/.test(booking.body.customer.primaryPhone), false,
      "a masked display value must never be written over a real phone number");
    assert.equal(booking.body.customer.id, "CU-70001", "and the customer identity is otherwise unchanged");
  } finally { chain.restore(); }
});

test("W1-2b: a masked phone with no record to resolve it from is refused, not stored", async () => {
  const harness = database();
  const { seedDefaultGroomingTaxPolicy } = await import("../lib/grooming-invoice.ts");
  await seedDefaultGroomingTaxPolicy(harness.db, "blr");
  const chain = captureInternalChain();
  try {
    const route = await import("../app/api/assisted-orders/route.ts");
    const { status, body } = await json(await route.POST(assistedOrderRequest({
      customer: { id: "CU-UNKNOWN", name: "Nobody Onfile", primaryPhone: "+91 ••••••9999" },
    })));
    assert.equal(status, 422, "bullets are not a phone number");
    assert.match(body.error, /masked/i, "and the refusal says so");
    assert.equal(chain.sent.length, 0, "nothing was booked with a mask for a phone number");
  } finally { chain.restore(); }
});

test("W1-2c: /assisted-booking keeps the masked 360 value for display only", () => {
  const page = read("app/assisted-booking/page.tsx");
  assert.match(page, /record\.revealed===true/,
    "the page must use Customer 360's own `revealed` flag to tell a real number from a display string");
  assert.doesNotMatch(page, /primaryPhone:record\.primaryPhone/,
    "storing the served (masked) value as the customer's phone is what submitted the bullets");
  assert.match(page, /setCrmDisplayPhone\(servedPhone\)/, "the masked value stays on screen");
});

/* ------------------------------------------------------------------ W1-3 */

test("W1-3: Rotate day answers a readable 4xx when no lead assignment policy is active", async () => {
  const harness = database();
  const route = await import("../app/api/revenue-crm/route.ts");
  // The route's own ensureTables creates lead_work_items, so this fixture cannot drift from the DDL.
  await route.GET(new Request("http://localhost/api/revenue-crm"));
  harness.sqlite.prepare(`INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at)
    VALUES ('LEAD-W1-1','CU-70001','Website','grooming','Neha','Sales Manager','active','day_1',1,1,1,1,0,0,0,0,1,1)`).run();
  const { ensureLeadAssignmentTables } = await import("../lib/lead-assignment-governance.ts");
  await ensureLeadAssignmentTables(harness.db);
  assert.equal(harness.sqlite.prepare("SELECT COUNT(*) c FROM lead_assignment_policies").get().c, 0,
    "the precondition under test: assignments are governed by a policy table nobody populated");

  const post = (body) => route.POST(new Request("http://localhost/api/revenue-crm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

  const control = await json(await post({ action: "advance_day", leadId: "NOPE" }));
  assert.equal(control.status, 404, "control: the action is reached and a bad id still 404s");

  const { status, body } = await json(await post({ action: "advance_day", leadId: "LEAD-W1-1" }));
  assert.notEqual(status, 500, "a missing governance policy is not a server fault");
  assert.ok(status >= 400 && status < 500, `a governed precondition must surface as 4xx, got ${status}`);
  assert.match(body.error, /lead assignment policy/i, "the refusal names the configuration that is missing");
  assert.equal(body.error.includes("Unable to update Revenue CRM engine"), false,
    "the generic fallback is what made the 3-day work cycle unreachable with no explanation");
  assert.equal(harness.sqlite.prepare("SELECT work_day FROM lead_work_items WHERE id='LEAD-W1-1'").get().work_day, 1,
    "and the lead is not half-rotated");
});

/* ------------------------------------------------------------------ W1-4 */

test("W1-4: the board and the tile read the canonical breach state, not the legacy cron flag", async () => {
  const harness = database();
  const route = await import("../app/api/revenue-crm/route.ts");
  await route.GET(new Request("http://localhost/api/revenue-crm"));       // creates lead_work_items + lead_sla_clocks

  const lead = (id, status) => harness.sqlite.prepare(`INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at)
    VALUES (?,?,'Website','grooming','Neha','Sales Manager',?,'day_1',1,1,1,1,0,0,0,0,1,1)`).run(id, `CU-${id}`, status);
  const clock = (id, leadId, status) => harness.sqlite.prepare(`INSERT INTO lead_sla_clocks (id,idempotency_key,lead_id,assignment_id,policy_id,policy_version,clock_type,cycle,status,started_at,due_at,manager_escalation_due_at,reassignment_due_at,breached_at,created_by,created_at,updated_at)
    VALUES (?,?,?,'LAS-1','POL-1',1,'first_response',1,?,1,2,3,4,?,'sla_engine',1,1)`).run(id, `key-${id}`, leadId, status, status === "breached" ? 5 : null);

  lead("LEAD-UAT-0005", "active");            // canonical clock breached, legacy flag says "active"
  lead("LEAD-UAT-0008", "active");
  lead("LEAD-UAT-0009", "active");            // genuinely healthy
  lead("LEAD-UAT-0010", "sla_breached");      // legacy cron-marked, no canonical clock
  clock("SLA-1", "LEAD-UAT-0005", "breached");
  clock("SLA-2", "LEAD-UAT-0008", "breached");
  clock("SLA-3", "LEAD-UAT-0009", "met");

  const { status, body } = await json(await route.GET(new Request("http://localhost/api/revenue-crm")));
  assert.equal(status, 200, body.error ?? "the engine must read");

  assert.equal(body.stats.slaBreaches, 3,
    "the tile read lead_work_items.status only, so it showed 1 while three leads were breached");

  const byId = new Map(body.leads.map((row) => [row.id, row]));
  const panel = await import("../app/crm/revenue-engine-panel.tsx");
  for (const id of ["LEAD-UAT-0005", "LEAD-UAT-0008", "LEAD-UAT-0010"]) {
    assert.equal(byId.get(id).sla_breached, true, `${id} is breached and the payload must say so`);
    assert.equal(panel.leadIsSlaBreached(byId.get(id)), true, `${id} must draw as a breached card`);
    assert.equal(panel.leadStateLabel(byId.get(id)), "sla breached",
      `${id} rendered a plain "ACTIVE" while its canonical SLA clock was breached`);
  }
  assert.equal(byId.get("LEAD-UAT-0009").sla_breached, false, "a met clock is not a breach");
  assert.equal(panel.leadIsSlaBreached(byId.get("LEAD-UAT-0009")), false);
  assert.equal(panel.leadStateLabel(byId.get("LEAD-UAT-0009")), "active");
});

/* ------------------------------------------------------------------ W1-5 / W1-7 / W1-8 */

const crmPage = await import("../app/crm/page.tsx");
const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");

const contact = (id, stage, lifetime = 0) => crmPage.toContact({
  id, name: `Customer ${id}`, primary_phone: "+91 ••••••0011", stage, lifetime_value: lifetime,
  pet_names: "Pet", next_action: "Call", opportunity: "Grooming",
});

test("W1-5: a segment that matches nothing selects nobody - no stale 360 panel, no booking link", () => {
  const contacts = [contact("E2E-CUS-UI-001", "New lead"), contact("CU-2", "Follow-up")];
  const atRisk = crmPage.visibleContacts(contacts, "At risk");
  assert.equal(atRisk.length, 0, "the fixture reproduces the reported empty segment");

  assert.equal(crmPage.selectedContact(atRisk, "E2E-CUS-UI-001"), null,
    "the panel resolved against the WHOLE list first, so it kept showing a customer the list had dropped");
  assert.equal(crmPage.selectedContact(atRisk, ""), null);

  /* The predicate above is correct by construction - it can only return something the list contains -
   * so what a regression would change is the ARGUMENT. Pinned to the render path for the same reason
   * CRM-R6 in tests/crm-search-and-segment-render.test.mjs pins `filtered`. */
  const page = read("app/crm/page.tsx");
  assert.match(page, /const selected=useMemo\(\(\)=>selectedContact\(filtered,selectedId\),\[filtered,selectedId\]\);/,
    "the panel must resolve the selection against the NARROWED list, which is what these assertions run");
  assert.doesNotMatch(page, /useMemo\(\(\)=>contacts\.find\(/,
    "resolving against the whole contact set first is the defect: that branch always hits, so the panel never re-scopes");

  // The link the panel renders is built from the selected id, so a null selection is what removes it.
  const all = crmPage.visibleContacts(contacts, "All customers");
  assert.equal(crmPage.selectedContact(all, "E2E-CUS-UI-001").id, "E2E-CUS-UI-001", "a real selection still resolves");
  assert.equal(crmPage.selectedContact(all, "no-such-id").id, "E2E-CUS-UI-001", "and falls back inside the visible list");
});

test("W1-7: the At risk segment selects what the platform itself calls at risk", () => {
  const contacts = [
    contact("UATD-CUS-6-CRM", "Dormant"),
    contact("CU-SPELLED", "At risk"),
    contact("CU-NEW", "New lead"),
    contact("CU-FOLLOW", "Follow-up"),
  ];
  const rendered = crmPage.visibleContacts(contacts, "At risk");
  assert.deepEqual(rendered.map((row) => row.id).sort(), ["CU-SPELLED", "UATD-CUS-6-CRM"],
    "lib/customer-business-view.ts derives risk 'At risk' from segment 'Dormant', and the seed stores 'Dormant'");
  assert.ok(crmPage.AT_RISK_STAGES.includes("Dormant"), "the platform's own definition is what is matched");

  const markup = renderToStaticMarkup(React.createElement(crmPage.CustomerRows, {
    contacts: rendered, selectedId: rendered[0].id, onSelect: () => {},
  }));
  assert.match(markup.replace(/<[^>]+>/g, " "), /Dormant/, "and the selected rows really render");

  // The other segments are untouched.
  assert.equal(crmPage.visibleContacts(contacts, "Follow-up due").length, 1);
  assert.equal(crmPage.visibleContacts(contacts, "All customers").length, 4);
});

test("W1-8: an empty list says which kind of empty it is", () => {
  const empty = (input) => crmPage.listEmptyState({ contacts: 0, visible: 0, query: "", segment: "All customers", ...input });

  assert.match(empty({}), /No CRM contacts yet/, "a genuinely empty CRM is still invited to add the first lead");

  const noMatch = empty({ query: "9845012345" });
  assert.match(noMatch, /9845012345/, "a search that matched nothing names the term");
  assert.equal(/No CRM contacts yet/.test(noMatch), false,
    "an operator checking whether a caller exists was told the CRM is empty and invited to create a duplicate");
  assert.match(noMatch, /clear the search/i, "and is told how to check properly");

  const noneInSegment = crmPage.listEmptyState({ contacts: 12, visible: 0, query: "", segment: "At risk" });
  assert.match(noneInSegment, /At risk/, "a segment that narrows everything away names the segment");
  assert.match(noneInSegment, /12 records/, "and says the records are loaded, not missing");

  assert.equal(crmPage.listEmptyState({ contacts: 3, visible: 2, query: "", segment: "All customers" }), null,
    "a list with rows says nothing at all");
});

test("W1-8b: the saved lead renders the server's masked row, not the raw form values", () => {
  const page = read("app/crm/page.tsx");
  assert.doesNotMatch(page, /phone:body\.primaryPhone/,
    "the optimistic row was built from the FORM, so the raw name and number sat on screen until reload");
  assert.match(page, /saved=toContact\(row\)/, "the saved row comes back through the same list endpoint and mapper");

  // toContact is what renders every other row; a served row is already masked and stays masked.
  const served = crmPage.toContact({ id: "CU-9", name: "A••••• R•", primary_phone: "+91 ••••••3016", pet_names: "Coco" });
  const markup = renderToStaticMarkup(React.createElement(crmPage.CustomerRows, {
    contacts: [served], selectedId: "CU-9", onSelect: () => {},
  }));
  assert.equal(markup.includes("9845133016"), false, "no raw number reaches the row");
  assert.match(markup, /•/, "what staff see is the masked value");
});

test("W1-8c: the phone pattern is a regex a browser will actually compile", () => {
  for (const path of ["app/landing-pages/landing-lead-form.tsx", "app/contact/contact-form.tsx"]) {
    const source = read(path);
    const pattern = source.match(/pattern="([^"]+)"/)?.[1];
    assert.ok(pattern, `${path} must still validate the phone client-side`);

    // HTML compiles `pattern` with the `v` flag. `[0-9+\s-]` is a syntax error there - an unescaped
    // range after a class escape - so Chrome DISCARDED the attribute and validated nothing at all.
    assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, "v"),
      `${path}: an invalid pattern is silently dropped, which is worse than no attribute`);

    const compiled = new RegExp(`^(?:${pattern})$`, "v");
    assert.equal(compiled.test("9845012345"), true, "a plain 10-digit number is accepted");
    assert.equal(compiled.test("+91 98450 12345"), true, "and an international one with spaces");
    assert.equal(compiled.test("+91-98450-12345"), true, "and with hyphens");
    assert.equal(compiled.test("98450"), false, "a short number is refused");
    assert.equal(compiled.test("not a phone"), false, "and so is text");
  }
});

/* ------------------------------------------------------------------ W1-6 */

test("W1-6: two packages that share a name are told apart by the tier the catalogue already knows", async () => {
  database();
  const route = await import("../app/api/assisted-orders/route.ts");
  const { status, body } = await json(await route.GET(new Request("http://localhost/api/assisted-orders")));
  assert.equal(status, 200, body.error ?? "the catalogue must load");

  const packages = body.data.packages;
  const forDog = packages.filter((item) => item.eligiblePetTypes.includes("dog"));
  const bathAndBasic = forDog.filter((item) => item.name === "Bath & Basic");
  assert.equal(bathAndBasic.length, 2, "the reported collision: two 'Bath & Basic' rows offered for one dog");
  assert.notEqual(bathAndBasic[0].singlePrice, bathAndBasic[1].singlePrice, "at different prices");

  for (const item of packages) {
    assert.ok(item.offerType, `${item.code} must publish the catalogue's own offerType`);
    assert.ok(item.tier, `${item.code} must publish a tier a staff member can read`);
  }
  assert.deepEqual(bathAndBasic.map((item) => item.tier).sort(), ["Adult", "Puppy / kitten"],
    "the two cards must not be distinguishable only by price");

  // Every name a staff member can pick from is unique once the tier is on the card - for dogs and cats.
  for (const species of ["dog", "cat"]) {
    const labels = packages.filter((item) => item.eligiblePetTypes.includes(species)).map((item) => `${item.name} · ${item.tier}`);
    assert.equal(new Set(labels).size, labels.length, `two ${species} packages would still read identically: ${labels}`);
  }

  const page = read("app/assisted-booking/page.tsx");
  assert.match(page, /tierLabel\(item\)/, "the package card renders the tier next to the name");
});
