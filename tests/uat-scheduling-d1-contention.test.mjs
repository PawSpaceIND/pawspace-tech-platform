import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const retry=await import("../lib/d1-write-retry.ts");

test("D1 scheduling write retry uses bounded exponential backoff for transient SQLITE_BUSY",async()=>{
  let attempts=0;
  const delays=[];
  const result=await retry.withD1WriteRetry(async()=>{
    attempts+=1;
    if(attempts<4){const error=new Error("database is locked");error.code="SQLITE_BUSY";throw error;}
    return "ok";
  },{attempts:6,baseDelayMs:10,maxDelayMs:160,random:()=>0,sleep:async delay=>{delays.push(delay);}});
  assert.equal(result,"ok");
  assert.equal(attempts,4);
  assert.deepEqual(delays,[10,20,40]);
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
