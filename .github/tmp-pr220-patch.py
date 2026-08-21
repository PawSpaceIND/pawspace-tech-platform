from pathlib import Path
import re


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected text not found in {path}")
    p.write_text(text.replace(old, new, 1))


# 1) Walking runtime: paise-safe pricing + one atomic completion batch.
path = Path("lib/walking-lifecycle.ts")
text = path.read_text()
old_money = 'export function walkingPerSessionAmount(pricing:Record<string,unknown>,totalAmount:unknown,sessionCount:unknown){const configured=Number(pricing.perWalkAmount||0);if(Number.isFinite(configured)&&configured>0)return configured;if(pricing.demoSeed===true){const total=Number(totalAmount),count=Number(sessionCount);if(Number.isFinite(total)&&total>0&&Number.isInteger(count)&&count>0)return total/count}return 0}'
new_money = 'export function walkingPerSessionAmount(pricing:Record<string,unknown>|null|undefined,totalAmount:unknown,sessionCount:unknown){const configured=Number(pricing?.perWalkAmount||0),configuredPaise=Math.round(configured*100);if(Number.isFinite(configured)&&configured>0&&Number.isSafeInteger(configuredPaise)&&Math.abs(configured*100-configuredPaise)<1e-9)return configuredPaise/100;if(pricing?.demoSeed===true){const total=Number(totalAmount),count=Number(sessionCount),totalPaise=Math.round(total*100);if(Number.isFinite(total)&&total>0&&Number.isSafeInteger(totalPaise)&&Math.abs(total*100-totalPaise)<1e-9&&Number.isInteger(count)&&count>0&&totalPaise%count===0)return totalPaise/count/100}return 0}'
if old_money not in text:
    raise SystemExit("walking money helper changed unexpectedly")
text = text.replace(old_money, new_money, 1)

pattern = re.compile(r' if\(input\.action==="complete_walk"\)\{[\s\S]*?\n \}\n throw new Response\("Unsupported Dog Walking lifecycle action"', re.M)
replacement = ''' if(input.action==="complete_walk"){
  if(sessionStatus!=="in_progress")throw new Response("Only an active Dog Walking session can be completed",{status:409});const routeSamples=await db.prepare("SELECT COUNT(*) count FROM walking_session_events WHERE booking_id=? AND session_id=? AND event_type='route_location_sample'").bind(booking.id,sessionId).first<{count:number}>();if(Number(routeSamples?.count||0)<2)throw new Response("Dog Walking UAT completion requires at least two canonical sandbox route samples",{status:409});
  const pricing=parse<Record<string,unknown>>(booking.pricing_json,{}),sessionCount=await db.prepare("SELECT COUNT(*) count FROM walking_sessions WHERE booking_id=?").bind(booking.id).first<{count:number}>(),amount=walkingPerSessionAmount(pricing,booking.total_amount,sessionCount?.count);if(!Number.isFinite(amount)||amount<=0)throw new Response("Canonical per-walk amount is missing",{status:409});
  const paymentEventId=crypto.randomUUID(),eventId=crypto.randomUUID(),pushNotificationId=crypto.randomUUID(),whatsappNotificationId=crypto.randomUUID(),routeSampleCount=Number(routeSamples?.count||0);const message=`Your PawSpace walk is complete. ${amount.toLocaleString("en-IN",{style:"currency",currency:"INR"})} is due in the UAT payment ledger; no live charge was made.`;
  await db.batch([
   db.prepare("UPDATE walking_sessions SET status='completed',completion_status='complete',updated_at=? WHERE id=? AND status='in_progress'").bind(now,session.id),
   db.prepare("UPDATE scheduling_reservations SET status='completed' WHERE id=?").bind(session.reservation_id),
   db.prepare("INSERT INTO walking_session_payment_events (id,booking_id,session_id,amount,currency,status,gateway,reference,detail_json,created_at,updated_at) VALUES (?,?,?,?,'INR','due','uat_sandbox',NULL,?,?,?)").bind(paymentEventId,booking.id,session.id,amount,JSON.stringify({captureRequired:true,liveMoney:false,trigger:"canonical_walk_completion"}),now,now),
   db.prepare("UPDATE canonical_bookings SET status=CASE WHEN EXISTS (SELECT 1 FROM walking_sessions WHERE booking_id=? AND status!='completed') THEN 'assigned' ELSE 'completed' END,updated_at=? WHERE id=?").bind(booking.id,now,booking.id),
   db.prepare("UPDATE provider_work_orders SET status=CASE WHEN EXISTS (SELECT 1 FROM walking_sessions WHERE booking_id=? AND status!='completed') THEN 'accepted' ELSE 'completed' END,updated_at=? WHERE booking_id=?").bind(booking.id,now,booking.id),
   db.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) SELECT ?,?,?,?,?,?,json_object('paymentEventId',?,'amount',?,'paymentStatus','due','liveMoney',json('false'),'allComplete',CASE WHEN EXISTS (SELECT 1 FROM walking_sessions WHERE booking_id=? AND status!='completed') THEN json('false') ELSE json('true') END,'routeSamples',?),?").bind(eventId,booking.id,sessionId,booking.provider_id,"walk_completed",input.actorId,paymentEventId,amount,booking.id,routeSampleCount,now),
   db.prepare("INSERT INTO walking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,'queued',?,?)").bind(pushNotificationId,booking.id,booking.customer_id,"push","walking_update",message,eventId,now),
   db.prepare("INSERT INTO walking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,'queued',?,?)").bind(whatsappNotificationId,booking.id,booking.customer_id,"whatsapp","walking_update",message,eventId,now),
   db.prepare("INSERT INTO walking_action_keys (idempotency_key,booking_id,action,result_json,created_at) SELECT ?,?,?,json_object('bookingId',?,'sessionId',?,'status','completed','paymentEventId',?,'paymentStatus','due','amount',?,'allComplete',CASE WHEN EXISTS (SELECT 1 FROM walking_sessions WHERE booking_id=? AND status!='completed') THEN json('false') ELSE json('true') END,'liveMoney',json('false'),'routeSamples',?),?").bind(input.idempotencyKey,input.bookingId,input.action,booking.id,sessionId,paymentEventId,amount,booking.id,routeSampleCount,now),
  ]);const stored=await prior(db,input.idempotencyKey);if(!stored)throw new Response("Dog Walking completion idempotency record is missing",{status:500});return stored
 }
 throw new Response("Unsupported Dog Walking lifecycle action"'''
text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit(f"walking completion replacement count={count}")
path.write_text(text)


# 2) Walking client: parsed JSON must be a non-null object before field access.
replace_once(
    "lib/walking-lifecycle-client.ts",
    'async function payload(response:Response){const text=await response.text(),body=(()=>{try{return JSON.parse(text) as {data?:unknown;error?:string}}catch{return{error:text.trim()||undefined}}})();return{response,body}}',
    'async function payload(response:Response){const text=await response.text(),body=(()=>{try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed as {data?:unknown;error?:string};return{error:`Walking lifecycle request failed (${response.status})`}}catch{return{error:text.trim()||`Walking lifecycle request failed (${response.status})`}}})();return{response,body}}',
)


# 3) Deterministic demo seed: preserve mutable Walking pricing and add real Training lifecycle evidence.
g = Path("scripts/uat-demo-seed-gen.mjs")
text = g.read_text()
replace_source = '  "lib/training-programme.ts",\n'
if '  "lib/training-session-lifecycle.ts",\n' not in text:
    if replace_source not in text:
        raise SystemExit("training source anchor missing")
    text = text.replace(replace_source, replace_source + '  "lib/training-session-lifecycle.ts",\n', 1)

train2 = '  { id: "UATD-BK-TRAIN-2", cus: "UATD-CUS-4", svc: "dog_training", provider: "train_meera", pkg: "Puppy Programme", amount: 3999, status: "cancelled", start: -3, pay: "created" },\n'
train3 = '  { id: "UATD-BK-TRAIN-3", cus: "UATD-CUS-5", svc: "dog_training", provider: "train_kiran", pkg: "Basic Obedience", amount: 4999, status: "in_progress", start: 0, pay: "captured" },\n'
if train3 not in text:
    if train2 not in text:
        raise SystemExit("training booking anchor missing")
    text = text.replace(train2, train2 + train3, 1)

unsafe = 'lines.push("UPDATE canonical_bookings SET pricing_json = json_set(COALESCE(pricing_json, \'{}\'), \'$.demoSeed\', json(\'true\'), \'$.perWalkAmount\', total_amount) WHERE id IN (\'UATD-BK-WALK-1\',\'UATD-BK-WALK-2\');");\n'
if unsafe not in text:
    raise SystemExit("unsafe Walking pricing mutation anchor missing")
text = text.replace(unsafe, "", 1)

completed_event = 'insert("training_programme_events", { id: "UATD-TPE-1", programme_id: "UATD-TP-1", booking_id: "UATD-BK-TRAIN-1", event_type: "demo_programme_completed", actor_id: "uat_demo_seed", detail_json: JSON.stringify({ demoSeed: true, sessionCount: 1 }), created_at: at(-10, 12) });\n'
consumption = 'insert("training_session_consumptions", { session_id: "UATD-TS-1", programme_id: "UATD-TP-1", booking_id: "UATD-BK-TRAIN-1", actor_id: "train_kiran", consumed_at: at(-10, 12) });\n'
if consumption not in text:
    if completed_event not in text:
        raise SystemExit("training completed fixture anchor missing")
    text = text.replace(completed_event, completed_event + consumption, 1)

cancelled_event = 'insert("training_programme_events", { id: "UATD-TPE-2", programme_id: "UATD-TP-2", booking_id: "UATD-BK-TRAIN-2", event_type: "demo_programme_cancelled", actor_id: "uat_demo_seed", detail_json: JSON.stringify({ demoSeed: true, sessionCount: 1 }), created_at: at(-3) });\n'
recovery_fixture = '''\ninsert("training_programmes", { id: "UATD-TP-3", booking_id: "UATD-BK-TRAIN-3", customer_id: "UATD-CUS-5", provider_id: "train_kiran", city_id: "blr", zone_id: "blr-east", plan_code: "dog_training", plan_name: "Basic Obedience", pet_ids_json: JSON.stringify(["UATD-CUS-5-PET"]), requirements_json: JSON.stringify(["demo_seed", "recovery_uat"]), meet_booking_id: null, status: "active", total_sessions: 1, completed_sessions: 0, no_show_sessions: 0, cancelled_sessions: 0, pricing_snapshot_json: JSON.stringify({ demoSeed: true }), created_at: at(-2), updated_at: at(0) });
insert("training_sessions", { id: "UATD-TS-3", programme_id: "UATD-TP-3", booking_id: "UATD-BK-TRAIN-3", schedule_reservation_id: "UATD-BK-TRAIN-3-RES", sequence_no: 1, provider_id: "train_kiran", scheduled_start: isoAt(0, 10), scheduled_end: isoAt(0, 12), status: "arrived", attendance_json: "{}", homework_json: "{}", progress_json: "{}", evidence_json: "[]", started_at: null, completed_at: null, created_at: at(-2), updated_at: at(0) });
insert("training_programme_events", { id: "UATD-TPE-3", programme_id: "UATD-TP-3", booking_id: "UATD-BK-TRAIN-3", event_type: "demo_session_arrived_for_recovery", actor_id: "uat_demo_seed", detail_json: JSON.stringify({ demoSeed: true, recoveryActionable: true }), created_at: at(0) });
'''
if 'id: "UATD-TP-3"' not in text:
    if cancelled_event not in text:
        raise SystemExit("training recovery fixture anchor missing")
    text = text.replace(cancelled_event, cancelled_event + recovery_fixture, 1)
g.write_text(text)


# 4) Focused source-level regressions, following the repository's existing test style.
Path("tests/walking-per-session-amount.test.mjs").write_text('''import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const walkingSource = await readFile(new URL("../lib/walking-lifecycle.ts", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../lib/walking-lifecycle-client.ts", import.meta.url), "utf8");

test("Walking completion accepts only paise-safe configured pricing", () => {
  assert.match(walkingSource, /pricing\?\.perWalkAmount/);
  assert.match(walkingSource, /configuredPaise=Math\.round\(configured\*100\)/);
  assert.match(walkingSource, /Math\.abs\(configured\*100-configuredPaise\)<1e-9/);
  assert.match(walkingSource, /return configuredPaise\/100/);
});

test("Walking demo fallback divides only when total paise divides exactly", () => {
  assert.match(walkingSource, /pricing\?\.demoSeed===true/);
  assert.match(walkingSource, /totalPaise=Math\.round\(total\*100\)/);
  assert.match(walkingSource, /totalPaise%count===0/);
  assert.match(walkingSource, /return totalPaise\/count\/100/);
  assert.doesNotMatch(walkingSource, /return total\/count/);
});

test("Walking pricing parser tolerates null pricing", () => {
  assert.match(walkingSource, /pricing:Record<string,unknown>\|null\|undefined/);
  assert.match(walkingSource, /pricing\?\.perWalkAmount/);
});

test("Walking completion commits state, payment, audit, notifications and idempotency in one batch", () => {
  const start = walkingSource.indexOf('if(input.action==="complete_walk")');
  const end = walkingSource.indexOf('throw new Response("Unsupported Dog Walking lifecycle action"');
  const block = walkingSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /await db\.batch\(\[/);
  assert.match(block, /walking_session_payment_events/);
  assert.match(block, /walking_session_events/);
  assert.match(block, /walking_customer_notifications/);
  assert.match(block, /walking_action_keys/);
  assert.match(block, /CASE WHEN EXISTS \(SELECT 1 FROM walking_sessions/);
  assert.doesNotMatch(block, /await event\(/);
  assert.doesNotMatch(block, /await notify\(/);
  assert.doesNotMatch(block, /return remember\(/);
});

test("Walking client rejects parsed null or non-object JSON safely", () => {
  assert.match(clientSource, /parsed&&typeof parsed==="object"&&!Array\.isArray\(parsed\)/);
  assert.match(clientSource, /Walking lifecycle request failed/);
});
''')

seed_test = Path("tests/uat-demo-seed.test.mjs")
seed_tests = seed_test.read_text()
new_test = '''\n\ntest("UAT demo seed preserves Walking pricing and exposes Training recovery evidence", () => {
  const sql = fs.readFileSync(new URL("../scripts/uat-demo-seed.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /UPDATE canonical_bookings SET pricing_json = json_set/);
  assert.match(sql, /INSERT OR IGNORE INTO training_session_consumptions .*UATD-TS-1/);
  assert.match(sql, /UATD-BK-TRAIN-3/);
  assert.match(sql, /UATD-TP-3/);
  assert.match(sql, /UATD-TS-3/);
  assert.match(sql, /'arrived'/);
});\n'''
if 'preserves Walking pricing and exposes Training recovery evidence' not in seed_tests:
    seed_test.write_text(seed_tests + new_test)
