import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {findCustomerReplay,isUniqueConstraintError} from "../lib/booking-replay-governance.ts";
import {enqueueCommunication} from "../lib/communication-engine.ts";

function makeD1(sqlite){
  const statement=(sql,args=[])=>({
    bind:(...bound)=>statement(sql,bound),
    first:async()=>sqlite.prepare(sql).get(...args)??null,
    run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes||0)}}},
    all:async()=>({results:sqlite.prepare(sql).all(...args)}),
  });
  return{
    prepare:(sql)=>statement(sql),
    batch:async(items)=>{sqlite.exec("BEGIN IMMEDIATE");try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec("COMMIT");return out}catch(error){sqlite.exec("ROLLBACK");throw error}},
    exec:async(sql)=>{sqlite.exec(sql);return{count:0,duration:0}},
  };
}

function world(){
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE canonical_bookings (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL,
      service_code TEXT NOT NULL,
      schedule_group_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,consent_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE after_booking_guard (id TEXT PRIMARY KEY);
    INSERT INTO canonical_customers(id,consent_json) VALUES ('CUS-1','{"serviceUpdates":true,"marketing":false}');
  `);
  return{sqlite,db:makeD1(sqlite)};
}

const input={customerId:"CUS-1",serviceCode:"pet_sitting",idempotencyKey:"idem-1",scheduleGroupId:"SG-1"};
const booking=(db,id="BK-1")=>db.prepare("INSERT INTO canonical_bookings(id,idempotency_key,customer_id,service_code,schedule_group_id,created_at) VALUES (?,?,?,?,?,?)")
  .bind(id,input.idempotencyKey,input.customerId,input.serviceCode,input.scheduleGroupId,1234);

for(const path of [
  "../app/api/canonical-bookings/route.ts",
  "../app/api/sitting-bookings/route.ts",
  "../app/api/walking-bookings/route.ts",
  "../app/api/taxi-bookings/route.ts",
]){
  test(`${path} installs the booking-conversation invariant before canonical insert`,()=>{
    const source=readFileSync(new URL(path,import.meta.url),"utf8");
    const replayCall=source.search(/await\s+findCustomerReplay\s*\(/);
    const insert=source.indexOf("INSERT INTO canonical_bookings");
    assert.ok(replayCall>=0,`${path} must execute findCustomerReplay`);
    assert.ok(insert>replayCall,`${path} must establish replay/conversation governance before canonical booking insert`);
  });
}

test("new booking creates one empty customer-only conversation and replay does not duplicate it",async()=>{
  const {sqlite,db}=world();
  assert.equal(await findCustomerReplay(db,input),null);
  await db.batch([booking(db)]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_threads").get().n,1);
  assert.deepEqual({...sqlite.prepare("SELECT customer_id,booking_id,status FROM communication_threads").get()},{customer_id:"CUS-1",booking_id:"BK-1",status:"open"});
  assert.deepEqual({...sqlite.prepare("SELECT participant_type,participant_id,role FROM communication_participants").get()},{participant_type:"customer",participant_id:"CUS-1",role:"customer"});
  assert.ok(await findCustomerReplay(db,input));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_threads").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_participants").get().n,1);
});

test("conversation failure participates in the booking transaction and retry is clean",async()=>{
  const {sqlite,db}=world();
  await findCustomerReplay(db,input);
  await assert.rejects(db.batch([booking(db),db.prepare("INSERT INTO after_booking_guard(id) VALUES ('x'),('x')")]),/UNIQUE/);
  for(const table of ["canonical_bookings","communication_threads","communication_participants"]){
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
  }
  await db.batch([booking(db)]);
  for(const table of ["canonical_bookings","communication_threads","communication_participants"]){
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,1,table);
  }
});

test("two creators that both miss replay still resolve to one booking conversation",async()=>{
  const {sqlite,db}=world();
  assert.equal(await findCustomerReplay(db,input),null);
  assert.equal(await findCustomerReplay(db,input),null);
  await db.batch([booking(db,"BK-A")]);
  let raced=null;
  try{await db.batch([booking(db,"BK-B")])}catch(error){
    assert.ok(isUniqueConstraintError(error));
    raced=await findCustomerReplay(db,input);
  }
  assert.ok(raced);
  assert.equal(raced.id,"BK-A");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_threads").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_participants").get().n,1);
});

test("an already-open booking thread is reused instead of duplicated",async()=>{
  const {sqlite,db}=world();
  await findCustomerReplay(db,input);
  sqlite.prepare("INSERT INTO communication_threads(id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES ('THREAD-PREEXISTING','CUS-1','BK-1',NULL,NULL,'open',NULL,NULL,1000,1000)").run();
  await db.batch([booking(db)]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_threads WHERE booking_id='BK-1'").get().n,1);
  assert.equal(sqlite.prepare("SELECT id FROM communication_threads WHERE booking_id='BK-1'").get().id,"THREAD-PREEXISTING");
  assert.deepEqual({...sqlite.prepare("SELECT thread_id,participant_type,participant_id,role FROM communication_participants").get()},{thread_id:"THREAD-PREEXISTING",participant_type:"customer",participant_id:"CUS-1",role:"customer"});
});

test("communication engine reuses the booking-created thread without adding a second conversation",async()=>{
  const {sqlite,db}=world();
  await findCustomerReplay(db,input);
  await db.batch([booking(db)]);
  const thread=sqlite.prepare("SELECT id FROM communication_threads WHERE booking_id='BK-1'").get();
  const queued=await enqueueCommunication(db,{
    customerId:"CUS-1",
    cityId:"blr",
    channel:"chat",
    purpose:"transactional",
    idempotencyKey:"booking-chat-probe-1",
    templateKey:"booking_chat_probe",
    payload:{text:"sandbox test only"},
    createdBy:"booking-conversation-connected-test",
    bookingId:"BK-1",
    asOf:2000,
  });
  assert.equal(queued.threadId,thread.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_threads WHERE booking_id='BK-1'").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_participants WHERE thread_id=?").get(thread.id).n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE thread_id=?").get(thread.id).n,1);
});
