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

test("Track 3 scheduling writes remain bounded, retrying and attempt-atomic after main convergence",()=>{
  const scheduling=fs.readFileSync(new URL("../app/api/uat-scheduling/route.ts",import.meta.url),"utf8");
  const leases=fs.readFileSync(new URL("../lib/scheduling-reservation-leases.ts",import.meta.url),"utf8");
  assert.match(scheduling,/withRetryingD1Writes\(env\.DB\)/);
  assert.match(scheduling,/attemptId=crypto\.randomUUID\(\)/);
  assert.match(scheduling,/attempt_id TEXT\)/);
  assert.match(scheduling,/ON CONFLICT\(provider_id,scheduled_start,scheduled_end\)/);
  assert.match(leases,/cleanupRunning=new WeakMap/);
  assert.match(leases,/SELECT DISTINCT r\.group_id/);
  assert.match(leases,/LIMIT 8/);
  assert.doesNotMatch(leases,/for\(const row of rows\.results\)/);
});


test("UAT roster writes remain explicitly environment-gated before assignment discovery",()=>{
  const scheduling=fs.readFileSync(new URL("../app/api/uat-scheduling/route.ts",import.meta.url),"utf8");
  assert.match(scheduling,/async function seedUatRoster/);
  assert.match(scheduling,/if\(!uatRosterSeedingEnabled\(env\)\)return/);
  assert.match(scheduling,/await seedUatRoster\(input,db\)/);
  const seed=scheduling.slice(scheduling.indexOf("async function seedUatRoster"),scheduling.indexOf("function repository"));
  assert.ok(seed.indexOf("if(!uatRosterSeedingEnabled(env))return")<seed.indexOf("INSERT"),"the UAT environment gate must run before synthetic availability writes");
});

test("expired reservation maintenance is bounded per foreground request",()=>{
  const leases=fs.readFileSync(new URL("../lib/scheduling-reservation-leases.ts",import.meta.url),"utf8");
  assert.match(leases,/LIMIT 8/);
  assert.match(leases,/groupIds\.map\(\(\)=>"\?"\)/);
  assert.match(leases,/scheduling_reservation_lease_cleanup[\s\S]*?released_at=\?/);
});


test("reservation claims are request-scoped and retain the authoritative atomic slot guard",()=>{
  const scheduling=fs.readFileSync(new URL("../app/api/uat-scheduling/route.ts",import.meta.url),"utf8");
  assert.match(scheduling,/attemptId=crypto\.randomUUID\(\)/,"each request must own a distinct rollback scope");
  assert.match(scheduling,/UPDATE scheduling_reservations SET status='cancelled' WHERE attempt_id=\?/);
  assert.match(scheduling,/WHERE NOT EXISTS \(SELECT 1 FROM scheduling_reservations WHERE provider_id=\?/);
  assert.match(scheduling,/ON CONFLICT\(provider_id,scheduled_start,scheduled_end\)[\s\S]*?DO NOTHING/,"the cross-isolate slot conflict must still be enforced at write time");
});

test("lease cleanup uses a non-destructive generation-aware marker claim",()=>{
  const leases=fs.readFileSync(new URL("../lib/scheduling-reservation-leases.ts",import.meta.url),"utf8");
  assert.doesNotMatch(leases,/INSERT OR REPLACE INTO scheduling_reservation_lease_cleanup/);
  assert.match(leases,/ON CONFLICT\(group_id\) DO UPDATE SET reason=excluded\.reason,released_at=excluded\.released_at WHERE scheduling_reservation_lease_cleanup\.released_at<excluded\.released_at/);
  assert.match(leases,/released_at=\?/);
});


test("Track 3 retained downstream batching removes redundant finance-policy waits",()=>{
  const ledger=fs.readFileSync(new URL("../lib/collection-ledger.ts",import.meta.url),"utf8");
  const finance=fs.readFileSync(new URL("../lib/finance-accounts.ts",import.meta.url),"utf8");
  assert.match(ledger,/const\[,policy\]=await Promise\.all/);
  assert.match(finance,/const\[period,existing\]=await Promise\.all/);
});


test("Track 3 finance reads avoid steady-state DDL and batch the grooming ledger",()=>{
  const route=fs.readFileSync(new URL("../app/api/grooming-finance/route.ts",import.meta.url),"utf8");
  const reconciliation=fs.readFileSync(new URL("../lib/grooming-payment-reconciliation.ts",import.meta.url),"utf8");
  assert.match(route,/groomingFinanceTablesEnsuring=new WeakMap/);
  assert.match(route,/await db\.batch\(\[ledgerStatement,exceptionsStatement\]\)/);
  assert.match(route,/LEFT JOIN \(SELECT payment_id,COUNT\(\*\) open_reconciliation_exceptions/);
  assert.doesNotMatch(route,/const recentExceptions=await db\.prepare/);
  assert.match(reconciliation,/reconciliationTablesEnsuring=new WeakMap/);
  assert.match(reconciliation,/reconciliationSchemaReady/);
});

test("Track 3 staging actor reads combine identity and role lookup in one D1 query",()=>{
  const auth=fs.readFileSync(new URL("../lib/uat-staging-auth.ts",import.meta.url),"utf8");
  assert.match(auth,/SELECT u\.name,u\.role_code,u\.status,r\.permissions_json FROM app_users u LEFT JOIN role_definitions/);
  assert.match(auth,/const uatActorReads=new WeakMap<Db,Map<string,Promise<Row\|null>>>\(\)/);
});


test("Track 3 coalesces concurrent finance snapshots and staging actor reads without stale TTL caching",()=>{
  const finance=fs.readFileSync(new URL("../app/api/grooming-finance/route.ts",import.meta.url),"utf8");
  const auth=fs.readFileSync(new URL("../lib/uat-staging-auth.ts",import.meta.url),"utf8");
  assert.match(finance,/const financeReads=new WeakMap<Db,Promise<FinanceSnapshot>>\(\)/);
  assert.match(finance,/const running=financeReads\.get\(db\);if\(running\)return running/);
  assert.match(finance,/finally\(\(\)=>\{if\(financeReads\.get\(db\)===pending\)financeReads\.delete\(db\);\}\)/);
  assert.doesNotMatch(finance,/setTimeout|expiresAt|cacheTtl/i);
  assert.match(auth,/const uatActorReads=new WeakMap<Db,Map<string,Promise<Row\|null>>>\(\)/);
  assert.match(auth,/const running=byEmail\.get\(email\);if\(running\)return running/);
  assert.match(auth,/finally\(\(\)=>\{if\(byEmail!\.get\(email\)===pending\)byEmail!\.delete\(email\);\}\)/);
});
