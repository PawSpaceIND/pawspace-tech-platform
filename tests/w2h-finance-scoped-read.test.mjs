/*
 * The finance role can open the two finance screens - and the finance read is not a way round the
 * customer-data guard it sits beside.
 *
 * /team/finance/relocation and /team/finance/funeral-memorial are the screens that set the approved
 * amount, record payment evidence and resolve refunds on relocation and funeral cases. Every one of
 * those actions requires finance.manage, which the `finance` role holds. The READ did not work: the
 * gateway resolved /api/relocation and /api/funeral-memorial at bookings.view, and the handlers then
 * demanded customers.view (PTJA W2-17-F03/F04, added because bookings.view is held by
 * service_provider too and those records carry the owner's address, pet, route and contact). `finance`
 * holds neither. The screens answered "Permission denied" to the only role whose job they are.
 *
 * Gating the LINK at bookings.view - which is what the hub honestly did - hid the screens from finance
 * instead of fixing them, and gating the GATEWAY alone would not have fixed them either: this suite
 * was written against the unfixed tree and showed the handler refusing a finance actor 403 with the
 * gateway already opened. Both layers had to move, and both are executed here.
 *
 * WHAT IS ASSERTED, all of it by executing the real code:
 *
 *   FIN-1  the gateway resolves ?scope=finance to finance.view for GET on both routes, leaves the
 *          unscoped read at bookings.view, and leaves every WRITE where it was;
 *   FIN-2  the real handlers serve a finance actor at ?scope=finance and still refuse it unscoped;
 *   FIN-3  a role that holds bookings.view (and customers.view) is UNAFFECTED - the unscoped staff
 *          read answers it exactly as before;
 *   FIN-4  the finance read carries no customer-identifying field, on a database with a real case in
 *          it - the allow-list is checked against actual rows, not against a comment;
 *   FIN-5  scope=finance is not a way to reach a mutation, and not a way for a role holding only
 *          bookings.view to read either.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W2H_FIN_DB__", "__W2H_FIN_ENV__");

// Deliberately NOT localhost: isDevelopmentPreviewRequest() hands a preview host a superuser actor
// holding ["*"], which would make every refusal below vacuous.
const HOST = "https://ops.pawspace.example";

const { requiredPermission } = await import("../lib/api-gateway.ts");
const { defaultRoles, hasPermission } = await import("../lib/platform-security.ts");
const serverAuth = await import("../lib/server-auth.ts");

const permissionsOf = (code) => {
  const role = defaultRoles.find((item) => item.code === code);
  assert.ok(role, `role ${code} is defined in lib/platform-security.ts`);
  return [...role.permissions];
};

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); } };
}

/** A fresh database with one seeded actor per role code, so no case can leak between cases. */
async function freshDatabase(actors) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__W2H_FIN_DB__ = makeD1(sqlite);
  globalThis.__W2H_FIN_ENV__ = {};
  await serverAuth.ensureSecurityTables(globalThis.__W2H_FIN_DB__);
  for (const [email, roleCode] of Object.entries(actors)) {
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .run(`USR-${roleCode}`, email, roleCode, roleCode, 1, 1);
  }
  return sqlite;
}

const ACTORS = { "fin@pawspace.in": "finance", "assoc@pawspace.in": "associate", "auditor@pawspace.in": "auditor", "prov@pawspace.in": "service_provider" };
const as = (email) => ({ headers: { "oai-authenticated-user-email": email, "content-type": "application/json" } });

/** Customer-identifying columns these two records carry. None may leave through the finance read. */
const RELOCATION_PII = ["customer_id", "pet_name", "breed", "origin_city", "destination_city", "target_travel_date", "documents", "events"];
const FUNERAL_PII = ["customer_id", "pickup_address", "alternate_contact"];

test("FIN-1: the gateway registers a finance-scoped READ and moves nothing else", async () => {
  const get = (path) => requiredPermission(new Request(`${HOST}${path}`));
  const post = (path, body) => requiredPermission(new Request(`${HOST}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  assert.equal(await get("/api/relocation?scope=finance&caseId=RLC-1"), "finance.view");
  assert.equal(await get("/api/funeral-memorial?scope=finance"), "finance.view");

  // Everything that was there before is still there, unchanged. A scoped read that quietly relaxed
  // the unscoped one would be a worse defect than the one being fixed.
  assert.equal(await get("/api/relocation"), "bookings.view");
  assert.equal(await get("/api/funeral-memorial"), "bookings.view");
  assert.equal(await get("/api/relocation?scope=customer"), "scheduling.book");
  assert.equal(await get("/api/funeral-memorial?scope=customer"), "scheduling.book");
  assert.equal(await get("/api/funeral-memorial?config=1"), "pricing.view");
  assert.equal(await get("/api/funeral-memorial?report=summary"), "reports.view");

  // WRITES are untouched, including a write that names the finance scope in its query string.
  assert.equal(await post("/api/relocation", { action: "record_payment", caseId: "RLC-1" }), "finance.manage");
  assert.equal(await post("/api/relocation", { action: "assign_vendor", caseId: "RLC-1" }), "bookings.manage");
  assert.equal(await post("/api/relocation?scope=finance", { action: "assign_vendor", caseId: "RLC-1" }), "bookings.manage",
    "scope=finance on a POST must not soften the write permission - it is a READ scope");
  assert.equal(await post("/api/funeral-memorial", { action: "set_service_amount", caseId: "FNR-1" }), "finance.manage");
  assert.equal(await post("/api/funeral-memorial", { action: "assign_vendor", caseId: "FNR-1" }), "bookings.manage");
  assert.equal(await post("/api/funeral-memorial?scope=finance", { action: "assign_vendor", caseId: "FNR-1" }), "bookings.manage");

  // And an unrecognised scope value falls back to the unscoped read rather than to anything looser.
  assert.equal(await get("/api/relocation?scope=finance_"), "bookings.view");
  assert.equal(await get("/api/funeral-memorial?scope=Finance"), "bookings.view");
});

test("FIN-1b: finance.view is the permission the finance role actually holds, and bookings.view is not", () => {
  // The premise of the whole fix, stated against the real catalogue rather than assumed.
  const finance = permissionsOf("finance");
  assert.equal(hasPermission(finance, "finance.view"), true);
  assert.equal(hasPermission(finance, "bookings.view"), false);
  assert.equal(hasPermission(finance, "customers.view"), false, "which is what the handlers demand on the unscoped read");
  assert.equal(hasPermission(finance, "finance.manage"), true, "so the actions on these screens were always permitted - only the read was not");
});

test("FIN-2: the real handlers serve a finance actor at scope=finance and still refuse it unscoped", async () => {
  const sqlite = await freshDatabase(ACTORS);
  const relocation = await import("../app/api/relocation/route.ts");
  const funeral = await import("../app/api/funeral-memorial/route.ts");

  for (const [label, handler, path] of [["relocation", relocation, "/api/relocation"], ["funeral", funeral, "/api/funeral-memorial"]]) {
    const scoped = await handler.GET(new Request(`${HOST}${path}?scope=finance`, as("fin@pawspace.in")));
    assert.equal(scoped.status, 200, `${label}: the finance role must be able to load its own finance screen`);
    assert.ok(Array.isArray((await scoped.json()).data), `${label}: and get a queue back, not an error envelope`);

    const unscoped = await handler.GET(new Request(`${HOST}${path}`, as("fin@pawspace.in")));
    assert.equal(unscoped.status, 403, `${label}: the unscoped staff read must still refuse the finance role`);
  }
  sqlite.close();
});

test("FIN-3: a role with bookings.view and customers.view is unaffected", async () => {
  const sqlite = await freshDatabase(ACTORS);
  const relocation = await import("../app/api/relocation/route.ts");
  const funeral = await import("../app/api/funeral-memorial/route.ts");

  // associate holds bookings.view AND customers.view - the pair the unscoped read has always needed.
  assert.equal(hasPermission(permissionsOf("associate"), "bookings.view"), true);
  assert.equal(hasPermission(permissionsOf("associate"), "customers.view"), true);
  for (const [label, handler, path] of [["relocation", relocation, "/api/relocation"], ["funeral", funeral, "/api/funeral-memorial"]]) {
    const before = await handler.GET(new Request(`${HOST}${path}`, as("assoc@pawspace.in")));
    assert.equal(before.status, 200, `${label}: the unscoped staff read must still answer the roles it always answered`);
  }
  sqlite.close();
});

test("FIN-4: the finance read carries the money and nothing that identifies the customer", async () => {
  /*
   * Asserted against a REAL row, created through the route's own create action, not against an empty
   * queue - an allow-list that is never exercised proves nothing. Every field name listed as customer
   * data must be absent from the finance payload while being present in the staff payload, so the
   * test also proves the field was there to be leaked.
   */
  const sqlite = await freshDatabase({ ...ACTORS, "cust@pawspace.in": "customer", "founder@pawspace.in": "founder" });
  const relocation = await import("../app/api/relocation/route.ts");
  const funeral = await import("../app/api/funeral-memorial/route.ts");

  const created = await relocation.POST(new Request(`${HOST}/api/relocation`, {
    ...as("founder@pawspace.in"), method: "POST",
    body: JSON.stringify({ action: "create", customerId: "CUS-PII-1", petName: "Simba", breed: "Indie", ageYears: 3, sizeClass: "medium", travelMode: "air", originCountry: "IN", originCity: "Bengaluru", destinationCountry: "AE", destinationCity: "Dubai", targetTravelDate: "2026-11-02", crateRequirement: "assessment_required" }),
  }));
  assert.equal(created.status, 201, "a relocation case is created to read back");
  const caseId = (await created.json()).data.id;

  const staffView = await relocation.GET(new Request(`${HOST}/api/relocation?caseId=${caseId}`, as("founder@pawspace.in")));
  assert.equal(staffView.status, 200);
  const staffCase = (await staffView.json()).data;
  for (const field of RELOCATION_PII) assert.ok(field in staffCase, `the staff read really does carry ${field} - otherwise FIN-4 would prove nothing`);
  assert.equal(staffCase.customer_id, "CUS-PII-1");

  const financeView = await relocation.GET(new Request(`${HOST}/api/relocation?scope=finance&caseId=${caseId}`, as("fin@pawspace.in")));
  assert.equal(financeView.status, 200, "the finance role loads the case its screen is about");
  const financeCase = (await financeView.json()).data;
  for (const field of RELOCATION_PII) assert.ok(!(field in financeCase), `the finance read must not carry ${field}`);
  assert.ok(!JSON.stringify(financeCase).includes("CUS-PII-1"), "nor the customer id anywhere inside it");
  assert.ok(!JSON.stringify(financeCase).includes("Simba"), "nor the pet");
  // It is still a usable finance record: the id it mutates by, and the commercial state it renders.
  assert.equal(financeCase.id, caseId);
  for (const field of ["status", "quote", "payment", "refunds", "settlement"]) assert.ok(field in financeCase, `the finance screen needs ${field}`);

  // A funeral case can only be created once its service type is enabled (409 otherwise).
  const enabled = await funeral.POST(new Request(`${HOST}/api/funeral-memorial`, {
    ...as("founder@pawspace.in"), method: "POST",
    body: JSON.stringify({ action: "save_service_config", serviceType: "cremation", enabled: true, baseAmount: 7500, cashAllowed: false }),
  }));
  assert.equal(enabled.status, 200, "cremation is enabled so a case can be created");

  const createdFuneral = await funeral.POST(new Request(`${HOST}/api/funeral-memorial`, {
    ...as("founder@pawspace.in"), method: "POST",
    body: JSON.stringify({ action: "create", customerId: "CUS-PII-2", petName: "Bruno", petSpecies: "dog", pickupAddress: "12 Residency Road, Bengaluru 560025", alternateContact: "+919812345678", serviceType: "cremation", memorialOption: "ash_collection" }),
  }));
  assert.equal(createdFuneral.status, 201, "a funeral case is created to read back");

  const funeralStaff = await funeral.GET(new Request(`${HOST}/api/funeral-memorial`, as("founder@pawspace.in")));
  const staffRow = (await funeralStaff.json()).data[0];
  for (const field of FUNERAL_PII) assert.ok(field in staffRow, `the staff read really does carry ${field}`);
  assert.equal(staffRow.pickup_address, "12 Residency Road, Bengaluru 560025");

  const funeralFinance = await funeral.GET(new Request(`${HOST}/api/funeral-memorial?scope=finance`, as("fin@pawspace.in")));
  assert.equal(funeralFinance.status, 200, "the finance role loads its funeral queue");
  const financeRows = (await funeralFinance.json()).data;
  assert.equal(financeRows.length, 1, "and sees the case");
  for (const field of FUNERAL_PII) assert.ok(!(field in financeRows[0]), `the finance read must not carry ${field}`);
  const serialised = JSON.stringify(financeRows);
  assert.ok(!serialised.includes("Residency Road"), "the pickup address must not appear anywhere in the finance payload");
  assert.ok(!serialised.includes("+919812345678"), "nor the alternate contact number");
  assert.ok(!serialised.includes("CUS-PII-2"), "nor the customer id");
  for (const field of ["id", "status", "service_type", "pet_name"]) assert.ok(field in financeRows[0], `the finance screen needs ${field} to name the case`);
  sqlite.close();
});

test("FIN-5: scope=finance opens nothing for a role that does not hold finance.view", async () => {
  const sqlite = await freshDatabase(ACTORS);
  const relocation = await import("../app/api/relocation/route.ts");
  const funeral = await import("../app/api/funeral-memorial/route.ts");

  // auditor, associate and service_provider all lack finance.view. associate is the sharp case: it
  // holds bookings.view and customers.view, so it CAN read these records - just not through this door,
  // which must not become a second, looser entrance to the same data.
  for (const email of ["assoc@pawspace.in", "auditor@pawspace.in", "prov@pawspace.in"]) {
    for (const [label, handler, path] of [["relocation", relocation, "/api/relocation"], ["funeral", funeral, "/api/funeral-memorial"]]) {
      const response = await handler.GET(new Request(`${HOST}${path}?scope=finance`, as(email)));
      assert.equal(response.status, 403, `${label}: ${email} holds no finance.view and must be refused the finance read`);
    }
  }

  // And the finance role's new read does not carry it into a write it never had.
  const response = await relocation.POST(new Request(`${HOST}/api/relocation?scope=finance`, {
    ...as("fin@pawspace.in"), method: "POST", body: JSON.stringify({ action: "assign_vendor", caseId: "RLC-NOPE", vendorId: "VND-1" }),
  }));
  assert.ok([403, 404].includes(response.status), `a finance actor must not reach an operations mutation through the finance scope (got ${response.status})`);
  sqlite.close();
});

/*
 * The last link in the chain: the SCREENS must actually use the new door.
 *
 * A gateway entry and a handler branch that no page calls would leave the defect exactly where it
 * was - the finance operator would still be sent to a screen that issues the unscoped read and gets
 * 403. So both pages are executed and the request they really make is read off the stub.
 */
const { mount, all, textOf } = await import("./helpers/customer-ui-harness.mjs");

/**
 * Records every URL the page fetches. The body it answers with is the FINANCE PROJECTION shape - a
 * single case for a caseId read, a queue for a list read - so the screens render the payload the
 * scoped read really returns rather than a shape invented for the stub.
 */
function recordingFetch() {
  const original = globalThis.fetch;
  const urls = [];
  const financeCase = { id: "RLC-1", status: "quote_issued", quote: { amount: 42000, status: "issued" }, payment: { status: "due" }, refunds: [], settlement: null, reconciliation: null };
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    urls.push(url);
    const body = JSON.stringify({ data: url.includes("caseId=") ? financeCase : [] });
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}

test("FIN-6: both finance screens read at scope=finance, not through the staff read that refuses them", async () => {
  const funeralPage = (await import("../app/team/finance/funeral-memorial/page.tsx")).default;
  const relocationPage = (await import("../app/team/finance/relocation/page.tsx")).default;

  // The funeral finance queue loads on mount.
  const funeralCalls = recordingFetch();
  try {
    const rendered = mount(funeralPage, {}, { label: "/team/finance/funeral-memorial" });
    await rendered.settle();
  } finally { funeralCalls.restore(); }
  assert.ok(funeralCalls.urls.length > 0, "the funeral finance screen reads something on open");
  for (const url of funeralCalls.urls) {
    assert.match(url, /scope=finance/, `the funeral finance screen must read at scope=finance, not ${url}`);
  }

  // The relocation finance screen loads one case by id, so drive its input and its Load control.
  const relocationCalls = recordingFetch();
  try {
    const rendered = mount(relocationPage, {}, { label: "/team/finance/relocation" });
    await rendered.settle();
    const input = all(rendered.tree(), (node) => node?.type === "input")[0];
    assert.ok(input, "the relocation finance screen offers a case id field");
    input.props.onChange({ target: { value: "RLC-1" } });
    await rendered.settle();
    const load = all(rendered.tree(), (node) => node?.type === "button").find((node) => /Load/.test(textOf(node)));
    assert.ok(load, "and a Load control");
    await load.props.onClick();
    await rendered.settle();
  } finally { relocationCalls.restore(); }
  assert.ok(relocationCalls.urls.length > 0, "the relocation finance screen reads a case when asked to");
  for (const url of relocationCalls.urls) {
    assert.match(url, /scope=finance/, `the relocation finance screen must read at scope=finance, not ${url}`);
    assert.match(url, /caseId=RLC-1/, "and must read the case the operator asked for");
  }
});
