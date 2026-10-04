/**
 * Stale geocode cache repair (publisher observation: canonical customer PIN 560043 beside a cached geocode row
 * reading 560113). Before: the cached row never matched the read (keyed on PIN/city/zone), the fresh INSERT hit
 * ON CONFLICT(address_id) DO NOTHING, and the re-read threw "Address geocode identity conflict" on every booking.
 * Now: inconsistent derived geocode data is an unusable cache. The unchanged canonical address is resolved, fresh
 * coordinates/PIN/governed city are validated, and ONLY the exact stale snapshot is replaced (compare-and-swap on
 * every column). A foreign owner is refused; concurrent drift is never overwritten.
 *
 * Nothing here attributes any historical human failure to this cause; it reproduces the mechanism with fixtures.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,sessionCookie} from "./helpers/grooming-journey-harness.mjs";

const CANONICAL={id:"ADDR-KN-1",customerId:"REPAIR-C",line1:"7 Hennur Main Road",area:"Kalyan Nagar & Banaswadi",city:"Bengaluru",postalCode:"560043"};
const STALE={pincode:"560113",cityId:"blr",zoneId:"blr-east",addressText:"7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, 560113, India",latitude:12.9,longitude:77.7,resolvedAt:1_700_000_000_000,updatedAt:1_700_000_000_000};

async function fixture(t){
 const ctx=await setupJourney();t.after(ctx.close);
 // The same tables the resolver creates (lib/service-discovery-address.ts ensureAddressTablesUncached), so the fixture rows exist before the first resolve.
 ctx.sqlite.exec("CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,label TEXT NOT NULL,line1 TEXT NOT NULL,line2 TEXT,area TEXT,city TEXT NOT NULL,postal_code TEXT,is_default INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS customer_service_address_geocodes (address_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pincode TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,resolved_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 const now=Date.now();
 ctx.sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)").run(CANONICAL.id,CANONICAL.customerId,"Home",CANONICAL.line1,null,CANONICAL.area,CANONICAL.city,CANONICAL.postalCode,now,now);
 return {...ctx,
  seedGeocode:(over={})=>{const g={address_id:CANONICAL.id,customer_id:CANONICAL.customerId,pincode:STALE.pincode,city_id:STALE.cityId,zone_id:STALE.zoneId,address_text:STALE.addressText,latitude:STALE.latitude,longitude:STALE.longitude,resolved_at:STALE.resolvedAt,updated_at:STALE.updatedAt,...over};ctx.sqlite.prepare("INSERT OR REPLACE INTO customer_service_address_geocodes (address_id,customer_id,pincode,city_id,zone_id,address_text,latitude,longitude,resolved_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(g.address_id,g.customer_id,g.pincode,g.city_id,g.zone_id,g.address_text,g.latitude,g.longitude,g.resolved_at,g.updated_at);return g;},
  // node:sqlite rows have a null prototype; plain objects make deepEqual compare values only.
  geocode:()=>({...ctx.sqlite.prepare("SELECT * FROM customer_service_address_geocodes WHERE address_id=?").get(CANONICAL.id)}),
  canonical:()=>({...ctx.sqlite.prepare("SELECT * FROM customer_addresses WHERE id=?").get(CANONICAL.id)}),
 };
}
async function resolve(db,over={}){const {resolveGovernedServiceAddress}=await import("../lib/service-discovery-address.ts");return resolveGovernedServiceAddress(db,{customerId:CANONICAL.customerId,serviceCode:"dog_training",saveToAccount:false,...over});}
async function refusal(promise){try{await promise;assert.fail("expected a refusal");}catch(error){if(!(error instanceof Response))throw error;return {status:error.status,text:await error.text()};}}


const services=["grooming","dog_training","boarding","pet_sitting","pet_taxi","dog_walking"];
for(const serviceCode of services){
 const run=(db,over={})=>resolve(db,{serviceCode,...over});
 test(`${serviceCode}: consistent saved cache is reused without write`,async t=>{
  const c=await fixture(t),g=c.seedGeocode({pincode:"560043",address_text:"7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, 560043, India"}),before=c.canonical();
  assert.equal((await run(c.db)).pincode,"560043");assert.deepEqual(c.geocode(),g);assert.deepEqual(c.canonical(),before);
 });
 test(`${serviceCode}: new address resolves without saving or replacing the default`,async t=>{
  const c=await fixture(t),before=c.canonical();
  const g=await run(c.db,{serviceAddress:"44 New Lane, Indiranagar, Bengaluru",servicePincode:"560038",saveToAccount:false});
  assert.equal(g.pincode,"560038");assert.equal(c.sqlite.prepare("SELECT COUNT(*) n FROM customer_addresses").get().n,1);assert.deepEqual(c.canonical(),before);
 });
 test(`${serviceCode}: explicit save adds a new address without replacing the default`,async t=>{
  const c=await fixture(t),before=c.canonical();
  const g=await run(c.db,{serviceAddress:"44 New Lane, Indiranagar, Bengaluru",servicePincode:"560038",saveToAccount:true});
  const row=c.sqlite.prepare("SELECT * FROM customer_addresses WHERE id=?").get(g.addressId);assert.equal(row.customer_id,CANONICAL.customerId);assert.equal(row.is_default,0);assert.deepEqual(c.canonical(),before);
 });
 test(`${serviceCode}: malformed saved PIN is refused without cache or address rewrite`,async t=>{
  const c=await fixture(t);c.sqlite.prepare("UPDATE customer_addresses SET postal_code='560 043' WHERE id=?").run(CANONICAL.id);
  const before=c.canonical(),g=c.seedGeocode();const a=await refusal(run(c.db));assert.equal(a.status,409);assert.match(a.text,/invalid PIN/);assert.deepEqual(c.geocode(),g);assert.deepEqual(c.canonical(),before);
 });
 test(`${serviceCode}: malformed new PIN is refused before writes`,async t=>{
  const c=await fixture(t),g=c.seedGeocode(),before=c.canonical();const a=await refusal(run(c.db,{serviceAddress:"44 New Lane, Indiranagar, Bengaluru",servicePincode:"5600 38"}));assert.equal(a.status,400);assert.deepEqual(c.geocode(),g);assert.deepEqual(c.canonical(),before);
 });
 test(`${serviceCode}: foreign cache owner is refused untouched`,async t=>{
  const c=await fixture(t),g=c.seedGeocode({customer_id:"FOREIGN"});const a=await refusal(run(c.db));assert.equal(a.status,409);assert.deepEqual(c.geocode(),g);
 });
 test(`${serviceCode}: exact text-only stale-PIN shape must repair`,async t=>{
  const c=await fixture(t),before=c.canonical();c.seedGeocode({pincode:"560043"});assert.equal((await run(c.db)).pincode,"560043");assert.doesNotMatch(c.geocode().address_text,/560113/);assert.deepEqual(c.canonical(),before);
 });
 test(`${serviceCode}: same-PIN different doorstep remains refused untouched`,async t=>{
  const c=await fixture(t),g=c.seedGeocode({pincode:"560043",address_text:"Different building, unit 999, Bengaluru, 560043"});const a=await refusal(run(c.db));assert.equal(a.status,409);assert.match(a.text,/identity conflict/);assert.deepEqual(c.geocode(),g);
 });
 test(`${serviceCode}: fresh wrong-PIN geocode must refuse BEFORE cache replacement`,async t=>{
  const c=await fixture(t),g=c.seedGeocode(),before=c.canonical(),env=globalThis.__GROOM_GOLDEN_ENV__,priorEnv={...env},priorFetch=globalThis.fetch;
  env.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE="off";env.GOOGLE_MAPS_SERVER_API_KEY_UAT="local-mocked-adapter";
  globalThis.fetch=async url=>{assert.equal(new URL(String(url)).hostname,"maps.googleapis.com");return Response.json({status:"OK",results:[{formatted_address:STALE.addressText,geometry:{location:{lat:13.03,lng:77.65}}}]});};
  try{assert.equal((await refusal(run(c.db))).status,409);assert.deepEqual(c.geocode(),g);assert.deepEqual(c.canonical(),before);}finally{globalThis.fetch=priorFetch;for(const k of Object.keys(env))delete env[k];Object.assign(env,priorEnv);}
 });
 test(`${serviceCode}: concurrent newer consistent cache is preserved`,async t=>{
  const c=await fixture(t);c.seedGeocode();const updated=Date.now()-50;
  const db={prepare(sql){if(/^UPDATE customer_service_address_geocodes/.test(sql))c.seedGeocode({pincode:"560043",address_text:"7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, 560043, India",latitude:13.02,longitude:77.64,updated_at:updated});return c.db.prepare(sql);},batch:xs=>c.db.batch(xs)};
  assert.equal((await run(db)).latitude,13.02);assert.equal(c.geocode().updated_at,updated);
 });
 test(`${serviceCode}: canonical revision drift must refuse before repair`,async t=>{
  const c=await fixture(t),g=c.seedGeocode();let changed=false;
  const db={prepare(sql){if(/^UPDATE customer_service_address_geocodes/.test(sql)&&!changed){changed=true;c.sqlite.prepare("UPDATE customer_addresses SET line1='8 Changed Road',updated_at=updated_at+1 WHERE id=?").run(CANONICAL.id);}return c.db.prepare(sql);},batch:xs=>c.db.batch(xs)};
  assert.equal((await refusal(run(db))).status,409);assert.deepEqual(c.geocode(),g);
 });
}
