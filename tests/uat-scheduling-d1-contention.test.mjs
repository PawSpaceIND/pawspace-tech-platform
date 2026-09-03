import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const retry=await import("../lib/d1-write-retry.ts");

test("D1 scheduling write retry uses bounded exponential backoff for transient SQLITE_BUSY",async()=>{
  let attempts=0;
  const delays=[];
  const result=await retry.withD1WriteRetry(async()=>{
    attempts+=1;
    if(attempts<3){const error=new Error("database is locked");error.code="SQLITE_BUSY";throw error;}
    return "ok";
  },{attempts:6,baseDelayMs:10,maxDelayMs:160,random:()=>0,sleep:async delay=>{delays.push(delay);}});
  assert.equal(result,"ok");
  assert.equal(attempts,3);
  assert.deepEqual(delays,[5,10]);
});

test("D1 scheduling write retry never retries SQLITE_CONSTRAINT",async()=>{
  let attempts=0;
  await assert.rejects(()=>retry.withD1WriteRetry(async()=>{
    attempts+=1;
    const error=new Error("UNIQUE constraint failed: scheduling_reservations.id");
    error.code="SQLITE_CONSTRAINT_UNIQUE";
    throw error;
  },{sleep:async()=>{throw new Error("constraint errors must not sleep");}}),error=>retry.isSqliteConstraintError(error));
  assert.equal(attempts,1);
});

test("retrying D1 wrapper retries run and batch writes but leaves reads untouched",async()=>{
  let runAttempts=0,batchAttempts=0,reads=0;
  const statement={
    bind(){return this;},
    async first(){reads+=1;return {ok:1};},
    async all(){reads+=1;return {results:[{ok:1}]};},
    async run(){runAttempts+=1;if(runAttempts<3){const error=new Error("database is busy");error.code="SQLITE_BUSY";throw error;}return {success:true,meta:{changes:1}};},
  };
  const db={
    prepare(){return statement;},
    async batch(){batchAttempts+=1;if(batchAttempts<2){const error=new Error("database table is locked");error.code="SQLITE_BUSY_SNAPSHOT";throw error;}return [{success:true,meta:{changes:1}}];},
    async exec(){return {count:0,duration:0};},
  };
  const wrapped=retry.withRetryingD1Writes(db);
  assert.deepEqual(await wrapped.prepare("SELECT 1").first(),{ok:1});
  assert.equal(reads,1);
  assert.equal((await wrapped.prepare("UPDATE x SET y=1").run()).success,true);
  assert.equal(runAttempts,3);
  assert.equal((await wrapped.batch([wrapped.prepare("INSERT INTO x VALUES (1)")]))[0].success,true);
  assert.equal(batchAttempts,2);
});

test("POST /api/uat-scheduling wires retrying D1 and converts database conflicts away from 500",()=>{
  const source=fs.readFileSync(new URL("../app/api/uat-scheduling/route.ts",import.meta.url),"utf8");
  assert.match(source,/withRetryingD1Writes\(env\.DB\)/);
  assert.match(source,/isSqliteConstraintError\(error\)[\s\S]*?SCHEDULING_CONFLICT[\s\S]*?,409\)/);
  assert.match(source,/isSqliteBusyError\(error\)[\s\S]*?SCHEDULING_BUSY[\s\S]*?,503\)/);
  const post=source.slice(source.indexOf("export async function POST"),source.indexOf("export async function GET"));
  assert.doesNotMatch(post,/isSqliteConstraintError\(error\)[\s\S]*?authError\(error,"Scheduling failed"\)[\s\S]*?isSqliteConstraintError/);
});


test("D1 retry policy hard-caps caller retry storms",async()=>{let attempts=0;const delays=[];await assert.rejects(()=>retry.withD1WriteRetry(async()=>{attempts+=1;const error=new Error("database is busy");error.code="SQLITE_BUSY";throw error;},{attempts:99,baseDelayMs:100,maxDelayMs:1000,maxTotalDelayMs:1000,random:()=>0.999999,sleep:async delay=>{delays.push(delay);}}),error=>retry.isSqliteBusyError(error));assert.equal(attempts,3);assert.deepEqual(delays,[50,50]);});

test("Track 3 write hot paths are bounded and atomic",()=>{const scheduling=fs.readFileSync(new URL("../app/api/uat-scheduling/route.ts",import.meta.url),"utf8");const leases=fs.readFileSync(new URL("../lib/scheduling-reservation-leases.ts",import.meta.url),"utf8");const canonical=fs.readFileSync(new URL("../app/api/canonical-bookings/route.ts",import.meta.url),"utf8");assert.match(scheduling,/schedulingTablesReady=new WeakMap/);assert.match(scheduling,/const availabilityRows=\(date:string\)=>/);assert.match(scheduling,/SELECT \* FROM scheduling_availability WHERE date=\?/);assert.match(scheduling,/statements\.length===1\?\[await statements\[0\]!\.run\(\)\]/);assert.match(scheduling,/ON CONFLICT\(provider_id,scheduled_start,scheduled_end\)/);assert.match(leases,/cleanupRunning=new WeakMap/);assert.match(leases,/SELECT DISTINCT r\.group_id/);assert.doesNotMatch(leases,/for\(const row of rows\.results\)/);assert.match(canonical,/withRetryingD1Writes\(env\.DB\)/);assert.match(canonical,/canonicalTablesReady=new WeakMap/);});


test("Track 3 UAT assignment discovery is read-only before the atomic reservation claim",()=>{
  const scheduling=fs.readFileSync(new URL("../app/api/uat-scheduling/route.ts",import.meta.url),"utf8");
  assert.doesNotMatch(scheduling,/async function seedUatRoster/);
  assert.doesNotMatch(scheduling,/await seedUatRoster\(input,db\)/);
  assert.match(scheduling,/syntheticUatRosterEnabled/);
  assert.match(scheduling,/uat_synthetic_/);
});

test("expired reservation maintenance is bounded per foreground request",()=>{
  const leases=fs.readFileSync(new URL("../lib/scheduling-reservation-leases.ts",import.meta.url),"utf8");
  assert.match(leases,/LIMIT 8/);
  assert.match(leases,/groupIds\.map\(\(\)=>"\?"\)/);
  assert.match(leases,/scheduling_reservation_lease_cleanup[\s\S]*?released_at=\?/);
});


test("reservation claim filters obvious same-provider/day losers before the atomic write",()=>{
  const scheduling=fs.readFileSync(new URL("../app/api/uat-scheduling/route.ts",import.meta.url),"utf8");
  assert.match(scheduling,/reservationClaimTails=new Map<string,Promise<void>>/);
  assert.match(scheduling,/withReservationClaimLane\(claimKey,executeAtomicClaim\)/);
  assert.match(scheduling,/SELECT EXISTS\(SELECT 1 FROM scheduling_reservations[\s\S]*?daily_jobs/);
  assert.match(scheduling,/ON CONFLICT\(provider_id,scheduled_start,scheduled_end\)/,"optimistic preflight must not replace the authoritative atomic cross-isolate claim");
});

test("lease cleanup uses a non-destructive generation-aware marker claim",()=>{
  const leases=fs.readFileSync(new URL("../lib/scheduling-reservation-leases.ts",import.meta.url),"utf8");
  assert.doesNotMatch(leases,/INSERT OR REPLACE INTO scheduling_reservation_lease_cleanup/);
  assert.match(leases,/ON CONFLICT\(group_id\) DO UPDATE SET reason=excluded\.reason,released_at=excluded\.released_at WHERE scheduling_reservation_lease_cleanup\.released_at<excluded\.released_at/);
  assert.match(leases,/released_at=\?/);
});


test("canonical downstream batching removes redundant new-booking D1 waits",()=>{
  const canonical=fs.readFileSync(new URL("../app/api/canonical-bookings/route.ts",import.meta.url),"utf8");
  const ledger=fs.readFileSync(new URL("../lib/collection-ledger.ts",import.meta.url),"utf8");
  const finance=fs.readFileSync(new URL("../lib/finance-accounts.ts",import.meta.url),"utf8");
  const leads=fs.readFileSync(new URL("../lib/lead-conversion-attribution.ts",import.meta.url),"utf8");
  assert.match(canonical,/const\[cityVerdict,replayConflict\]=await Promise\.all/);
  assert.match(canonical,/const\[assignment,reservations\]=await Promise\.all/);
  assert.match(canonical,/serviceCode:input\.serviceCode,paymentStatus:paymentStatusPersisted/);
  assert.doesNotMatch(canonical,/const booking=await timedBookingStage\("booking_readback"/);
  assert.match(ledger,/const\[,policy\]=await Promise\.all/);
  assert.match(finance,/const\[period,existing\]=await Promise\.all/);
  assert.match(leads,/const\[schema,columns\]=await Promise\.all/);
});
