import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__TRANSACTION_BOUNDARY_DB__", "__TRANSACTION_BOUNDARY_ENV__");

const ORIGIN = "https://app.pawspace.in";
const CUSTOMER = "CUS-CANONICAL-SITTING-1";
const PROVIDER = "PRV-CANONICAL-SITTING-1";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    sql,
    args,
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const item of items) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

async function sessionCookie(db) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app",
    principalType: "phone",
    principalKey: "+919999000011",
    subjectType: "customer",
    subjectId: CUSTOMER,
    cityId: "blr",
    verificationState: "verified",
    expiresAt: null,
    metadata: {},
    actorId: "test",
    reason: "canonical Sitting quote boundary",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id),
    identitySource: "customer_app",
    principalType: "phone",
    principalKey: String(binding.principal_key),
    subjectType: "customer",
    subjectId: CUSTOMER,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function world() {
  const directory = mkdtempSync(join(tmpdir(), "booking-boundary-"));
  const path = join(directory, "test.sqlite");
  const sqlite = new DatabaseSync(path);
  const rival = new DatabaseSync(path);
  const db = makeD1(sqlite);
  globalThis.__TRANSACTION_BOUNDARY_DB__ = db;
  globalThis.__TRANSACTION_BOUNDARY_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  sqlite.exec(`
    CREATE TABLE scheduling_assignment_decisions (
      group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL DEFAULT 'auto',shortlist_json TEXT NOT NULL DEFAULT '[]',
      selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL
    );
    CREATE TABLE scheduling_reservations (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,
      city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL DEFAULT '[]',
      scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,
      occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,
      explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL
    );
  `);

  const cookie = await sessionCookie(db);
  const start = new Date(Date.now() + 72 * 60 * 60_000);
  start.setUTCHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60_000); // a Home Visit is one 60-minute window (SIT-04)
  return { sqlite, rival, directory, db, cookie, start: start.toISOString(), end: end.toISOString() };
}

function seedSchedule(sqlite, { groupId, start, end }) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,selected_provider_id,status,updated_at) VALUES (?,?, 'assigned',?)")
    .run(groupId, PROVIDER, now);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'assigned',?)")
    .run(`RES-${groupId}`, groupId, PROVIDER, "pet_sitting", "blr", "blr-east", CUSTOMER, start, end, now);
}

async function commercial(db, { start, end, paymentMode = "prepaid", paymentKey = crypto.randomUUID() }) {
  const { createSittingQuote } = await import("../lib/sitting-governance.ts");
  const { captureSittingQuoteSandbox } = await import("../lib/sitting-payment-governance.ts");
  const quote = await createSittingQuote(db, {
    packageCode: "sitting-visit-60",
    petCount: 1,
    cityId: "blr",
    zoneId: "blr-east",
    scheduledStart: start,
    scheduledEnd: end,
    paymentMode,
  });
  const capture = await captureSittingQuoteSandbox(db, {
    quoteId: quote.quoteId,
    amount: quote.amountDueNow,
    paymentKey,
  });
  return { quote, capture };
}

function payload({ groupId, start, end, quote, key = `BOOK-${groupId}`, overrides = {} }) {
  const base = {
    idempotencyKey: key,
    scheduleGroupId: groupId,
    customer: { id: CUSTOMER, name: "Canonical Sitting Customer", primaryPhone: "+919999000011" },
    pets: [{ sourceId: "sit-pet-1", name: "Milo", species: "dog", vaccinationStatus: "verified" }],
    cityId: "blr",
    zoneId: "blr-east",
    serviceCode: "pet_sitting",
    packageCode: quote?.packageCode ?? "free-plan",
    packageName: quote?.packageName ?? "Free Sitting",
    scheduledStart: start,
    scheduledEnd: end,
    provider: { id: PROVIDER, name: "Canonical Sitter", model: "full_time" },
    totalAmount: quote?.totalAmount ?? 0,
    amountDueNow: quote?.amountDueNow ?? 0,
    payment: { method: "card", mode: quote?.paymentMode ?? "prepaid", status: "captured", detail: "server-attested sandbox capture" },
    pricing: { discount: 0, sittingQuoteId: quote?.quoteId },
  };
  return {
    ...base,
    ...overrides,
    payment: { ...base.payment, ...(overrides.payment ?? {}) },
    pricing: { ...base.pricing, ...(overrides.pricing ?? {}) },
  };
}

async function book(cookie, body) {
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request(`${ORIGIN}/api/canonical-bookings`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify(body),
  }));
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { response, data };
}


async function fixture(t) {
  const w = await world();
  t.after(() => { w.rival.close(); w.sqlite.close(); rmSync(w.directory,{recursive:true,force:true}); });
  const groupId = "BOUNDARY-GROUP";
  seedSchedule(w.sqlite,{groupId,...w});
  w.sqlite.prepare("UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?").run(JSON.stringify({request:{customerId:CUSTOMER,serviceCode:"pet_sitting",cityId:"blr",zoneId:"blr-east",serviceAddress:"123 Test Road Bengaluru",servicePincode:"560001",latitude:12.97,longitude:77.59}}),groupId);
  const { quote } = await commercial(w.db,w);
  const body = payload({groupId,...w,quote});
  body.sittingQuoteId=quote.quoteId;
  const capacity=await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(w.db);
  const block=()=>w.rival.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES ('BLOCK',?,?,?,'test block','active','test',1,1)").run(PROVIDER,w.start,w.end);
  return {...w,groupId,body,block};
}
async function sitting(w) {
  const {POST}=await import("../app/api/sitting-bookings/route.ts");
  return POST(new Request(`${ORIGIN}/api/sitting-bookings`,{method:"POST",headers:{"content-type":"application/json",origin:ORIGIN,cookie:w.cookie},body:JSON.stringify(w.body)}));
}
test("Sitting refuses an already unavailable provider without partial writes",async t=>{
  const w=await fixture(t);w.block();
  const response=await sitting(w);
  assert.equal(response.status,409,await response.text());
  assert.equal(w.sqlite.prepare("SELECT count(*) n FROM canonical_bookings").get().n,0);
});
test("Sitting catches leave committed independently immediately before its booking transaction",async t=>{
  const w=await fixture(t),batch=w.db.batch;
  w.db.batch=async items=>{if(items.some(x=>x.sql?.startsWith("INSERT INTO canonical_bookings")))w.block();return batch(items);};
  const response=await sitting(w);
  assert.equal(response.status,409,await response.text());
  assert.equal(w.sqlite.prepare("SELECT count(*) n FROM canonical_bookings").get().n,0);
  assert.equal(w.sqlite.prepare("SELECT count(*) n FROM booking_payments").get().n,0);
});
for(const late of [false,true])test(`canonical cleanup preserves an independently committed winner (${late?'transaction refusal':'preflight refusal'})`,async t=>{
  const w=await fixture(t);
  // Initialize real route tables without creating a booking.
  const probe={...w.body,provider:{...w.body.provider,id:"wrong-provider"}};
  assert.equal((await book(w.cookie,probe)).response.status,409);
  const win=()=>w.rival.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES ('WINNER','WINNER-KEY',?,'[]','[]','blr','blr-east','pet_sitting','test','test',?,?,?,?,'confirmed',399,'test',1,1)").run(CUSTOMER,w.groupId,PROVIDER,w.start,w.end);
  if(late){const batch=w.db.batch;w.db.batch=async items=>{if(items.some(x=>x.sql?.startsWith("INSERT INTO canonical_bookings"))){win();w.block();}return batch(items);};}
  else {const prepare=w.db.prepare;w.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith("SELECT id FROM provider_unavailability")){const bind=statement.bind;statement.bind=(...args)=>{const bound=bind(...args),first=bound.first;bound.first=async()=>{win();w.block();return first();};return bound;};}return statement;};}
  const result=await book(w.cookie,w.body);
  assert.equal(result.response.status,409,JSON.stringify(result.data));
  assert.equal(w.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(w.groupId).status,'assigned');
  assert.equal(w.sqlite.prepare("SELECT status FROM scheduling_assignment_decisions WHERE group_id=?").get(w.groupId).status,'assigned');
  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='WINNER'").get().status,'confirmed');
});

test("Sitting eligible creation and idempotent replay keep payment pending",async t=>{
 const w=await fixture(t);const first=await sitting(w);assert.equal(first.status,201,await first.clone().text());
 w.block();const replay=await sitting(w);assert.equal(replay.status,200,await replay.clone().text());
 assert.equal((await replay.json()).data.duplicatePrevented,true);
 assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings").get().status,"payment_pending");
});
test("authoritative canonical insert rejects a block without a marker, and accepts touching boundaries",async t=>{
 const w=await fixture(t);await book(w.cookie,{...w.body,provider:{...w.body.provider,id:"wrong"}});
 w.block();
 const insert=()=>w.rival.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES ('DIRECT','DIRECT-KEY',?,'[]','[]','blr','blr-east','pet_sitting','test','test','DIRECT-GROUP',?,?,?,'payment_pending',399,'test',1,1)").run(CUSTOMER,PROVIDER,w.start,w.end);
 assert.throws(insert,/provider_unavailable_before_booking/);
 w.rival.prepare("UPDATE provider_unavailability SET ends_at=?").run(w.start);
 assert.doesNotThrow(insert);
});

test("canonical refusal still releases an unbooked group's reservations",async t=>{
 const w=await fixture(t);w.block();const result=await book(w.cookie,w.body);
 assert.equal(result.response.status,409,JSON.stringify(result.data));
 assert.equal(w.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(w.groupId).status,"cancelled");
 assert.equal(w.sqlite.prepare("SELECT status FROM scheduling_assignment_decisions WHERE group_id=?").get(w.groupId).status,"reassignment_needed");
});
