import test from"node:test";
import assert from"node:assert/strict";
import{readFileSync}from"node:fs";
import{freshCountingD1}from"./helpers/d1-harness.mjs";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";
installWorkersHooks("__DPDP_E2E_DB__");
const{eraseCustomerPersonalData}=await import("../lib/dpdp-erasure.ts");
const{runDpdpRetentionSweep}=await import("../lib/dpdp-retention.ts");

const now=Date.UTC(2026,8,12,3,45,0,0);
const customerId="DPDP-E2E-CUSTOMER";

function seedSchema(sqlite){
 const migration=readFileSync(new URL("../drizzle/0036_dpdp_consent_ledger.sql",import.meta.url),"utf8");
 sqlite.exec(migration);
 sqlite.exec(`
  CREATE TABLE app_users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE atlas_secure_context_facts(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pet_id TEXT,fact_type TEXT NOT NULL,sensitivity TEXT NOT NULL,ciphertext_b64 TEXT NOT NULL,iv_b64 TEXT NOT NULL,content_hash TEXT NOT NULL,status TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE atlas_vector_memories(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pet_id TEXT,memory_type TEXT NOT NULL,sensitivity TEXT NOT NULL,content_hash TEXT NOT NULL,content_text TEXT NOT NULL,vector_id TEXT NOT NULL UNIQUE,embedding_model TEXT NOT NULL,embedding_dimensions INTEGER NOT NULL,vector_metric TEXT NOT NULL,status TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 `);
}

test("DPDP erasure removes all Atlas PII/behavioral rows and tombstones root identity",async()=>{
 const{sqlite,db}=freshCountingD1();seedSchema(sqlite);
 sqlite.prepare("INSERT INTO app_users VALUES (?,?,?,?,?,?,?)").run(customerId,"person@example.test","DPDP Test Parent","customer","active",now-1000,now-1000);
 sqlite.prepare("INSERT INTO dpdp_consent_records VALUES (?,?,?,?,?,?)").run("CONSENT-1",customerId,"marketing","granted","sha256:203.0.113.10",now-900);
 sqlite.prepare("INSERT INTO atlas_secure_context_facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("SECURE-1",customerId,null,"phone","pii","cipher","iv","hash-secure","active","e2e",now-800,now-800);
 sqlite.prepare("INSERT INTO atlas_vector_memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("VECTOR-1",customerId,null,"behavioral","non_sensitive","hash-vector","Dog prefers quiet visits","vec-1","@cf/baai/bge-m3",1024,"cosine","active","e2e",now-700,now-700);
 const result=await eraseCustomerPersonalData(db,{customerId,idempotencyKey:"DPDP-E2E-ERASE-1",requestedBy:"privacy@pawspace.test",reason:"e2e right to erasure proof",now});
 assert.equal(result.status,"COMPLETED");
 assert.equal(result.ledgerPreserved,true);
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM atlas_secure_context_facts WHERE customer_id=?").get(customerId).count,0);
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM atlas_vector_memories WHERE customer_id=?").get(customerId).count,0);
 const user=sqlite.prepare("SELECT email,name,status FROM app_users WHERE id=?").get(customerId);
 assert.equal(user.status,"deleted");
 assert.notEqual(user.email,"person@example.test");
 assert.notEqual(user.name,"DPDP Test Parent");
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM dpdp_consent_records WHERE customer_id=?").get(customerId).count,1);
 assert.throws(()=>sqlite.prepare("DELETE FROM dpdp_consent_records WHERE id='CONSENT-1'").run(),/append-only/);
 sqlite.close();
});

test("30-day DPDP transient sweeper purges stale telemetry and deleted-account Atlas residue only",async()=>{
 const{sqlite,db}=freshCountingD1();seedSchema(sqlite);
 const stale=now-31*24*60*60*1000,recent=now-5*24*60*60*1000;
 sqlite.exec("CREATE TABLE universal_provider_location_events(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL); CREATE TABLE route_eta_snapshots(id TEXT PRIMARY KEY,calculated_at INTEGER NOT NULL);");
 sqlite.prepare("INSERT INTO app_users VALUES (?,?,?,?,?,?,?)").run("DELETED-1","old@example.test","Old User","customer","deleted",stale-1000,stale-1000);
 sqlite.prepare("INSERT INTO atlas_secure_context_facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("SECURE-STALE","DELETED-1",null,"phone","pii","cipher","iv","hash","active","e2e",stale,stale);
 sqlite.prepare("INSERT INTO atlas_vector_memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("VECTOR-STALE","DELETED-1",null,"behavioral","non_sensitive","hash","history","vec-stale","@cf/baai/bge-m3",1024,"cosine","active","e2e",stale,stale);
 sqlite.prepare("INSERT INTO universal_provider_location_events VALUES (?,?)").run("GPS-OLD",stale);
 sqlite.prepare("INSERT INTO universal_provider_location_events VALUES (?,?)").run("GPS-NEW",recent);
 sqlite.prepare("INSERT INTO route_eta_snapshots VALUES (?,?)").run("ETA-OLD",stale);
 sqlite.prepare("INSERT INTO route_eta_snapshots VALUES (?,?)").run("ETA-NEW",recent);
 const result=await runDpdpRetentionSweep(db,{asOf:now});
 assert.equal(result.transient.status,"completed");
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM atlas_secure_context_facts WHERE customer_id='DELETED-1'").get().count,0);
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM atlas_vector_memories WHERE customer_id='DELETED-1'").get().count,0);
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM universal_provider_location_events").get().count,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM route_eta_snapshots").get().count,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM app_users WHERE id='DELETED-1'").get().count,1);
 sqlite.close();
});
