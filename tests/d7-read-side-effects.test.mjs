import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__D7_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return {url: CF_STUB, shortCircuit: true};
    try { return nextResolve(specifier, context); }
    catch (error) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context); throw error; }
  }});
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context); throw error; }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) { return {
    bind: (...boundArgs) => statement(sql, boundArgs),
    first: async () => { const row=sqlite.prepare(sql).get(...args); return row===undefined?null:row; },
    run: async () => { const info=sqlite.prepare(sql).run(...args); return {success:true,meta:{changes:Number(info.changes)}}; },
    all: async () => ({results: sqlite.prepare(sql).all(...args)}),
  };}
  return {prepare:(sql)=>statement(sql,[]),batch:async(statements)=>{const out=[];for(const stmt of statements)out.push(await stmt.run());return out;},exec:async(sql)=>{sqlite.exec(sql);return {count:0,duration:0};}};
}

let sqlite;
function freshDb(){sqlite=new DatabaseSync(":memory:");globalThis.__D7_DB__=makeD1(sqlite);}
const tableNames=()=>sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name);

const scheduling=await import("../app/api/uat-scheduling/route.ts");
const workQueue=await import("../app/api/ops-work-queue/route.ts");

async function json(response){return {status:response.status,body:await response.json()};}

// The authorization substrate is the one thing a guarded route unavoidably provisions: resolveActor
// (lib/server-auth.ts) calls ensureSecurityTables before it can decide anything, so EVERY guarded route
// creates these tables on a cold database. This GET used to create nothing only because it was not
// guarded at all - it answered 200 to an anonymous caller with the whole day board, every reservation's
// group, provider, service, zone and CUSTOMER ID (PTJA-P1-F36). It is guarded now.
//
// So the invariant this test protects is stated as what it always meant: a READ must not create or seed
// DOMAIN tables. Anything outside the identity substrate below still fails here, and the two explicit
// checks that no scheduling_* table and no provider_capacity_profiles appear are unchanged.
const IDENTITY_SUBSTRATE=["app_users","customer_identity_links","identity_binding_audit","identity_bindings","provider_identity_links","role_definitions","security_audit_events","security_audit_outbox"];

test("D7 runtime: scheduling GET on a cold DB returns an empty board without creating or seeding domain tables", async()=>{
  freshDb();
  const before=tableNames();
  const result=await json(await scheduling.GET(new Request("http://localhost/api/uat-scheduling?date=2026-09-01")));
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.deepEqual(result.body.data.providers,[]);
  assert.equal(result.body.data.total,0);
  const created=tableNames().filter(name=>!before.includes(name));
  const domain=created.filter(name=>!IDENTITY_SUBSTRATE.includes(name));
  assert.deepEqual(domain,[],`GET must not CREATE scheduling/provider domain tables on a cold DB: ${domain.join(", ")}`);
  assert.equal(tableNames().some(name=>name.startsWith("scheduling_")),false);
  assert.equal(tableNames().includes("provider_capacity_profiles"),false);
});

test("D7 runtime: ops work-queue GET on a cold DB returns an empty snapshot without creating queue tables", async()=>{
  freshDb();
  const before=tableNames();
  const result=await json(await workQueue.GET(new Request("http://localhost/api/ops-work-queue")));
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.data.metrics.total,0);
  assert.equal(result.body.data.metrics.open,0);
  assert.deepEqual(tableNames(),before,"GET must not CREATE work-queue/security tables on a cold DB");
  assert.equal(tableNames().includes("ops_work_queue_tasks"),false);
  assert.equal(tableNames().includes("ops_work_queue_events"),false);
});

test("D7 contract: GET bodies do not call schema initializers or the mutating work-queue sweep",()=>{
  const schedulingSource=fs.readFileSync("app/api/uat-scheduling/route.ts","utf8");
  const schedulingGet=schedulingSource.slice(schedulingSource.indexOf("export async function GET"));
  assert.doesNotMatch(schedulingGet,/seedProviderCapacityDefaults\(|ensureSchedulingTables\(/);
  const opsSource=fs.readFileSync("app/api/ops-work-queue/route.ts","utf8");
  const opsGet=opsSource.slice(opsSource.indexOf("export async function GET"),opsSource.indexOf("export async function POST"));
  assert.doesNotMatch(opsGet,/sweepWorkQueue\(|ensureWorkQueueTables\(/);
  const queueLib=fs.readFileSync("lib/ops-work-queue.ts","utf8");
  const snapshot=queueLib.slice(queueLib.indexOf("export async function workQueueSnapshot"),queueLib.indexOf("export async function workQueueTaskWithEvents"));
  const detail=queueLib.slice(queueLib.indexOf("export async function workQueueTaskWithEvents"));
  assert.doesNotMatch(snapshot,/ensureWorkQueueTables\(/);
  assert.doesNotMatch(detail,/ensureWorkQueueTables\(/);
});