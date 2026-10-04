import {DatabaseSync} from 'node:sqlite';
/**
 * The ONE synthetic fixture-isolation world: Founder identity, CUS0000 and the documented Bengaluru roster,
 * a SELECT-only D1 facade and the certified staging runtime variables. Shared by the route unit test and the
 * compiled-artifact HTTP contract test so there is a single fixture, not two drifting copies.
 * `assert` is injected so the facade fails the caller's own test on any write attempt.
 */
export function fixtureIsolationWorld({SHA,overrides={},assert,STAGING_PROVIDER_FIXTURES}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(`CREATE TABLE app_users(id TEXT,email TEXT,name TEXT,role_code TEXT,status TEXT);CREATE TABLE role_definitions(code TEXT,permissions_json TEXT);CREATE TABLE canonical_customers(id TEXT,city_id TEXT,primary_phone TEXT,secondary_phone TEXT,email TEXT,source TEXT);CREATE TABLE canonical_providers(id TEXT,city_id TEXT,phone TEXT,email TEXT,source TEXT);CREATE TABLE boarding_host_profiles(provider_id TEXT,city_id TEXT);CREATE TABLE provider_capacity_profiles(id TEXT,city_id TEXT,live INTEGER,status TEXT,updated_by TEXT,services_json TEXT,provider_model TEXT DEFAULT 'full_time');INSERT INTO app_users VALUES ('F','founder@synthetic.test','Test Founder','founder','active');INSERT INTO role_definitions VALUES ('founder','["*"]');INSERT INTO canonical_customers VALUES ('CUS0000','blr','9100000000',NULL,NULL,'uat_seed');`);
 for(const [id,phone] of Object.entries(STAGING_PROVIDER_FIXTURES)){sqlite.prepare("INSERT INTO canonical_providers VALUES (?,'blr',?,NULL,'uat_staging_seed')").run(id,phone);sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,live,status,updated_by,services_json) VALUES (?,'blr',1,'active','founder_seed','[\"grooming\"]')").run(id);}
 const reads=[];const db={prepare(sql){assert.match(sql,/^SELECT\b/,'attestation must not write');reads.push(sql);let args=[];const statement={bind(...v){args=v;return statement},async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return {results:sqlite.prepare(sql).all(...args)}}};return statement},batch(){assert.fail('no D1 batch allowed')},exec(){assert.fail('no D1 exec allowed')}};
 const env={PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_PRODUCTION_ENFORCE:'false',PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:'x'.repeat(32),PAWSPACE_STAGING_BUILD_SHA:SHA,PAWSPACE_VERSION_METADATA:{id:'11111111-1111-4111-8111-111111111111',timestamp:'2026-09-30T10:00:00Z'},PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',PAWSPACE_RAZORPAYX_ENV:'sandbox',PAWSPACE_RAZORPAYX_LIVE_APPROVED:'false',PAWSPACE_COMMUNICATION_ENV:'uat',PAWSPACE_VOICE_ENV:'uat',PAWSPACE_STAGING_LIVE_CUSTOMER_OTP:'false',PAWSPACE_SCHEDULING_ENV:'uat',...overrides};
 return {sqlite,db,env,reads};
}
