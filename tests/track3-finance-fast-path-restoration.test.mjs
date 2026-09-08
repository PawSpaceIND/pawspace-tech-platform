import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";

function locked(){
  assert.equal(process.env.APP_ENV,"staging");
  assert.equal(process.env.PAWSPACE_PAYMENT_ENV,"sandbox");
  assert.equal(process.env.FORBID_PRODUCTION,"true");
}

test("Track 3 restoration is absolutely staging/sandbox locked",()=>locked());

test("finance fast path stays downstream of authorization and staging+sandbox only",()=>{
  locked();
  const source=readFileSync("app/api/grooming-finance/route.ts","utf8");
  assert.match(source,/STAGING_FINANCE_CACHE_TTL_SECONDS=30/);
  assert.match(source,/PAWSPACE_DEPLOYMENT_ENV\|\|""\)===\"staging\"&&String\(vars\.PAWSPACE_PAYMENT_ENV\|\|""\)===\"sandbox\"/);
  assert.match(source,/await authorize\(request,"finance\.view"\);\s*const cached=await readStagingFinanceCache\(\)/);
  assert.match(source,/const snapshot=await loadFinanceSnapshot\(db\);await writeStagingFinanceCache\(snapshot\)/);
  assert.match(source,/await invalidateStagingFinanceCache\(\)/);
  assert.match(source,/await db\.batch\(\[ledgerStatement,exceptionsStatement\]\)/);
});

test("staging actor cache remains downstream of signed-cookie verification",()=>{
  locked();
  const source=readFileSync("lib/uat-staging-auth.ts","utf8");
  assert.match(source,/UAT_ACTOR_EDGE_CACHE_TTL_SECONDS=30/);
  assert.match(source,/const email=await verifyUatToken\(env,token\);\s*if\(!email\)return null;\s*const user=await readUatActorRow\(db,email\)/);
  assert.match(source,/const cached=await readCachedUatActor\(email\);if\(cached\)return cached/);
  assert.match(source,/String\(row\.status\)===\"active\"&&row\.permissions_json!==null/);
});

test("direct Worker authorization sanitization preserves the original POST body",async()=>{
  locked();
  const {requestForAuthorization}=await import("../lib/trusted-workspace-identity.ts");
  const original=new Request("https://pawspace-staging.example.workers.dev/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json","oai-authenticated-user-email":"spoof@example.com"},body:JSON.stringify({serviceCode:"grooming",clientRequestId:"track3-body"})});
  const inspection=requestForAuthorization(original,{PAWSPACE_DEPLOYMENT_ENV:"staging"});
  assert.equal(inspection.headers.get("oai-authenticated-user-email"),null);
  assert.deepEqual(await inspection.json(),{serviceCode:"grooming",clientRequestId:"track3-body"});
  assert.deepEqual(await original.json(),{serviceCode:"grooming",clientRequestId:"track3-body"});
});

test("certified finance hot-path indexes avoid temp sort trees",()=>{
  locked();
  const db=new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,service_code TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE INDEX idx_grooming_finance_bookings_service_updated ON canonical_bookings(service_code,updated_at DESC);CREATE TABLE payment_reconciliation_exceptions(id TEXT PRIMARY KEY,payment_id TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL);CREATE INDEX idx_payment_reconciliation_exceptions_status_payment ON payment_reconciliation_exceptions(status,payment_id);CREATE INDEX idx_payment_reconciliation_exceptions_status_created ON payment_reconciliation_exceptions(status,created_at DESC);`);
  const plans=[
    db.prepare("EXPLAIN QUERY PLAN SELECT * FROM canonical_bookings WHERE service_code='grooming' ORDER BY updated_at DESC LIMIT 200").all(),
    db.prepare("EXPLAIN QUERY PLAN SELECT payment_id,COUNT(*) FROM payment_reconciliation_exceptions WHERE status='open' GROUP BY payment_id").all(),
    db.prepare("EXPLAIN QUERY PLAN SELECT * FROM payment_reconciliation_exceptions WHERE status='open' ORDER BY created_at DESC LIMIT 50").all(),
  ].map(rows=>rows.map(row=>String(row.detail)).join("\n"));
  assert.match(plans[0],/idx_grooming_finance_bookings_service_updated/i);
  assert.match(plans[1],/idx_payment_reconciliation_exceptions_status_payment/i);
  assert.match(plans[2],/idx_payment_reconciliation_exceptions_status_created/i);
  for(const detail of plans)assert.doesNotMatch(detail,/USE TEMP B-TREE/i);
});

test("closure load harness keeps the full workload and long-lived synthetic staging token",()=>{
  locked();
  const source=readFileSync("scripts/ops/staging-performance-gate-closure.mjs","utf8");
  assert.match(source,/exp:Date\.now\(\)\+2\*60\*60\*1000/);
  assert.match(source,/prepared\.length < 100/);
  assert.match(source,/offset<500/);
  assert.match(source,/offset<10000/);
  assert.match(source,/p95>=750/);
});

test("Track 3 certification removes only staging cron triggers for the load window and always restores them",()=>{
  locked();
  const source=readFileSync(".github/workflows/track3-finance-closure-certification.yml","utf8");
  assert.match(source,/PAWSPACE_PAYMENT_LIVE_APPROVED: 'false'/);
  assert.match(source,/configuredCrons/);
  assert.match(source,/delete triggers\.crons/);
  assert.match(source,/cronIsolation:'disabled_for_track3_benchmark'/);
  assert.match(source,/Drain pre-isolation scheduled invocations/);
  assert.match(source,/sleep 660/);
  assert.match(source,/name: Restore staging cron trigger/);
  assert.match(source,/if: always\(\)/);
  assert.match(source,/cron-restored/);
  assert.match(source,/triggers\.crons=evidence\.configuredCrons/);
});
