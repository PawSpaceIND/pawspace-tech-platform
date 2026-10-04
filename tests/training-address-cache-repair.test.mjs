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

test("stale cached geocode: the unchanged canonical address is re-geocoded and ONLY that stale snapshot is replaced",async t=>{
 const c=await fixture(t);const before=c.canonical();c.seedGeocode();
 const governed=await resolve(c.db);
 assert.equal(governed.pincode,CANONICAL.postalCode);assert.equal(governed.cityId,"blr");assert.equal(governed.zoneId,"blr-east");
 const row=c.geocode();
 assert.equal(row.pincode,CANONICAL.postalCode,"the cached PIN now agrees with the canonical address");
 assert.equal(row.customer_id,CANONICAL.customerId);assert.equal(row.city_id,"blr");assert.equal(row.zone_id,"blr-east");
 assert.doesNotMatch(row.address_text,/560113/);assert.match(row.address_text,/560043/);
 assert.ok(Number.isFinite(row.latitude)&&Number.isFinite(row.longitude)&&row.latitude>=-90&&row.latitude<=90&&row.longitude>=-180&&row.longitude<=180,"fresh coordinates are finite and in range");
 assert.notEqual(row.latitude,STALE.latitude);assert.ok(row.updated_at>STALE.updatedAt&&row.resolved_at>STALE.resolvedAt,"the snapshot was replaced, not kept");
 assert.deepEqual({latitude:governed.latitude,longitude:governed.longitude},{latitude:row.latitude,longitude:row.longitude},"the booking uses the repaired coordinates");
 assert.deepEqual(c.canonical(),before,"no canonical PIN rewrite, no saved-record edit");
 assert.equal(c.sqlite.prepare("SELECT COUNT(*) n FROM customer_service_address_geocodes").get().n,1,"one row per address id, replaced in place");
});

test("a consistent cache is reused untouched (no gratuitous re-geocode or rewrite)",async t=>{
 const c=await fixture(t);const seeded=c.seedGeocode({pincode:"560043",address_text:"7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, 560043, India",latitude:13.01,longitude:77.63});
 const governed=await resolve(c.db);
 assert.deepEqual(c.geocode(),seeded,"nothing changed");
 assert.deepEqual({latitude:governed.latitude,longitude:governed.longitude},{latitude:13.01,longitude:77.63});
});

test("same PIN, different doorstep text: still an identity conflict (owner contract), never repaired",async t=>{
 const c=await fixture(t);const before=c.canonical();const conflicting=c.seedGeocode({pincode:"560043",address_text:"Different building, unit 999, Bengaluru, 560043",latitude:13.0,longitude:77.6});
 const answer=await refusal(resolve(c.db));
 assert.equal(answer.status,409);assert.match(answer.text,/^Address geocode identity conflict/);
 assert.deepEqual(c.geocode(),conflicting,"a text-only conflict is evidence, not drift: untouched");assert.deepEqual(c.canonical(),before);
});

test("an unsaved search has no canonical row to repair from: drift under its id stays an identity conflict",async t=>{
 const c=await fixture(t);
 // An unsaved search (saveToAccount:false) leaves a geocode row but no customer_addresses row under its id.
 const text="44 Unsaved Lane, Indiranagar, Bengaluru";
 const first=await resolve(c.db,{serviceAddress:text,servicePincode:"560038"});
 assert.equal(c.sqlite.prepare("SELECT COUNT(*) n FROM customer_addresses WHERE id=?").get(first.addressId).n,0,"nothing saved");
 c.sqlite.prepare("UPDATE customer_service_address_geocodes SET pincode='560113',address_text=? WHERE address_id=?").run(text+", 560113, India",first.addressId);
 const answer=await refusal(resolve(c.db,{serviceAddress:text,servicePincode:"560038"}));
 assert.equal(answer.status,409);assert.match(answer.text,/^Address geocode identity conflict/);
 assert.equal(c.sqlite.prepare("SELECT pincode FROM customer_service_address_geocodes WHERE address_id=?").get(first.addressId).pincode,"560113","nothing was rewritten");
});

test("malformed CALLER PIN: refused by the strict contract before any cache or canonical row is touched; nothing is 'corrected'",async t=>{
 const c=await fixture(t);const before=c.canonical();const stale=c.seedGeocode();
 for(const bad of ["56004","560 43","5600431","O60043"]){
  const answer=await refusal(resolve(c.db,{serviceAddress:"7 Hennur Main Road, Kalyan Nagar, Bengaluru",servicePincode:bad}));
  assert.deepEqual([answer.status,answer.text],[400,"A valid 6-digit service PIN code is required"],bad);
 }
 assert.deepEqual(c.geocode(),stale,"the stale row is untouched by a refused request");
 assert.deepEqual(c.canonical(),before,"the canonical PIN is never rewritten");
});

test("foreign owner: a geocode row held by another customer is refused, never repaired or reused",async t=>{
 const c=await fixture(t);const before=c.canonical();const foreign=c.seedGeocode({customer_id:"SOMEONE-ELSE"});
 const answer=await refusal(resolve(c.db));
 assert.equal(answer.status,409);assert.match(answer.text,/^Address geocode identity conflict/);
 assert.deepEqual(c.geocode(),foreign,"the other customer's row is untouched");assert.deepEqual(c.canonical(),before);
});

/** A db whose UPDATE of the stale snapshot is preceded by another writer's change to the same row. */
function driftingDb(c,drift){return{prepare(sql){if(/^UPDATE customer_service_address_geocodes/.test(sql))drift();return c.db.prepare(sql);},batch:statements=>c.db.batch(statements)};}

test("concurrent drift to a consistent row: the other writer's newer data is kept, not overwritten",async t=>{
 const c=await fixture(t);c.seedGeocode();
 const other={pincode:"560043",address_text:"7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, 560043, India",latitude:13.02,longitude:77.64,resolved_at:Date.now()-1000,updated_at:Date.now()-1000};
 const governed=await resolve(driftingDb(c,()=>c.seedGeocode(other)));
 const row=c.geocode();
 assert.deepEqual({latitude:row.latitude,longitude:row.longitude,updated_at:row.updated_at},{latitude:13.02,longitude:77.64,updated_at:other.updated_at},"the compare-and-swap matched nothing; the newer row stands");
 assert.deepEqual({latitude:governed.latitude,longitude:governed.longitude},{latitude:13.02,longitude:77.64},"and this request books against the row that is actually stored");
});

test("concurrent drift to an inconsistent row: refused for a safe retry, nothing overwritten, no coverage bypass",async t=>{
 const c=await fixture(t);c.seedGeocode();
 const other=c.seedGeocode.bind(null,{pincode:"560001",zone_id:"blr-central",address_text:"somewhere else 560001",latitude:12.95,longitude:77.6,updated_at:Date.now()-500});
 let written=null;
 const answer=await refusal(resolve(driftingDb(c,()=>{written=other();})));
 assert.equal(answer.status,409);assert.match(answer.text,/^Address geocode changed while it was being verified/);
 const row=c.geocode();
 assert.deepEqual({pincode:row.pincode,latitude:row.latitude,updated_at:row.updated_at},{pincode:"560001",latitude:12.95,updated_at:written.updated_at},"the other writer's row is left exactly as written");
 const {publicAddressRefusal}=await import("../lib/service-discovery-address.ts");
 const pub=publicAddressRefusal(answer.status,answer.text);
 assert.deepEqual([pub.code,pub.reason],["SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE","verification_retry"]);assert.doesNotMatch(pub.error,/PIN/);
});

test("route: a stale cache no longer blocks the customer's saved address, and a failure creates no booking or reservation",async t=>{
 const c=await fixture(t);
 c.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT,vaccination_status TEXT,created_at INTEGER,updated_at INTEGER)");
 c.sqlite.prepare("INSERT OR REPLACE INTO canonical_customers(id,name,primary_phone,city_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(CANONICAL.customerId,"Repair Customer","9000800961","blr","active",Date.now(),Date.now());
 c.sqlite.prepare("INSERT OR REPLACE INTO canonical_pets(id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES ('REPAIR-P',?,'Milo','dog','verified',?,?)").run(CANONICAL.customerId,Date.now(),Date.now());
 const cookie=await sessionCookie(c.db,'customer',CANONICAL.customerId,`customer:${CANONICAL.customerId}`);
 const at=new Date(Date.now()+7*86400000);at.setUTCHours(4,30,0,0);
 const {POST}=await import("../app/api/uat-scheduling/route.ts");
 const call=async over=>{const response=await POST(new Request("https://uat.pawspace.in/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({action:"preview",clientRequestId:"REPAIR-PREVIEW",customerId:CANONICAL.customerId,petIds:["REPAIR-P"],serviceCode:"dog_training",scheduledStart:at.toISOString(),scheduledEnd:new Date(at.getTime()+3600000).toISOString(),occurrences:1,...over})}));return {status:response.status,body:await response.json()};};
 const count=table=>c.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?c.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n:0;
 // 1. Foreign-owned stale row: refused with a safe reason; nothing reserved, nothing repaired.
 c.seedGeocode({customer_id:"SOMEONE-ELSE"});
 const refused=await call({action:"reserve",clientRequestId:"REPAIR-RESERVE-1"});
 assert.equal(refused.status,409,JSON.stringify(refused.body));assert.deepEqual([refused.body.code,refused.body.reason],["SERVICE_ADDRESS_UNVERIFIED","identity_conflict"]);
 assert.equal(count("scheduling_reservations"),0);assert.equal(count("canonical_bookings"),0);assert.equal(c.geocode().customer_id,"SOMEONE-ELSE");
 // 2. The customer's own stale row (560113 beside canonical 560043): the saved address resolves and the row is repaired.
 c.seedGeocode();
 const preview=await call({});
 assert.equal(preview.status,200,JSON.stringify(preview.body));assert.ok(Array.isArray(preview.body.data?.providers));
 assert.equal(c.geocode().pincode,CANONICAL.postalCode);assert.equal(count("scheduling_reservations"),0,"a preview reserves nothing");
 assert.equal(c.canonical().postal_code,CANONICAL.postalCode);
});


// ---------------------------------------------------------------------------------------------------------------
// v8: the exact observed shape, fresh geocoder evidence validated before any write, and the canonical-address race.
// ---------------------------------------------------------------------------------------------------------------
const OBSERVED={pincode:"560043",address_text:"7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, 560113, India",city_id:"blr",zone_id:"blr-east",latitude:12.99,longitude:77.65};
const FRESH_OK="7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, Karnataka 560043, India";

/** Fixture off and a placeholder (non-secret) Maps key, with fetch stubbed: the real geocodeAddress parses a synthetic answer; nothing leaves the process. */
async function withMockGeocoder(answer,run){
 const env=globalThis.__GROOM_GOLDEN_ENV__,prior={...env},priorFetch=globalThis.fetch,calls=[];
 env.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE="off";env.GOOGLE_MAPS_SERVER_API_KEY_UAT="placeholder-not-a-credential";
 globalThis.fetch=async url=>{calls.push(String(url));if(!String(url).startsWith("https://maps.googleapis.com/"))throw new Error("unexpected network call");return new Response(JSON.stringify(answer),{status:200,headers:{"content-type":"application/json"}});};
 try{return await run(calls);}finally{globalThis.fetch=priorFetch;for(const key of Object.keys(env))if(!(key in prior))delete env[key];Object.assign(env,prior);}
}
const geocoderAnswer=(formatted_address,lat=13.0213,lng=77.6411)=>({status:"OK",results:[{formatted_address,geometry:{location:{lat,lng}}}]});

test("CANARY exact observed shape: PIN column 560043 (matches canonical) but cached TEXT says 560113 is repaired, not refused",async t=>{
 const c=await fixture(t);const before=c.canonical();c.seedGeocode(OBSERVED);
 const governed=await resolve(c.db);
 const row=c.geocode();
 assert.equal(row.pincode,"560043");assert.doesNotMatch(row.address_text,/560113/,"the contradictory derived text is gone");assert.match(row.address_text,/560043/);
 assert.ok(row.updated_at>STALE.updatedAt,"the stale snapshot was replaced");
 assert.ok(Number.isFinite(row.latitude)&&Number.isFinite(row.longitude));
 assert.equal(governed.pincode,"560043");assert.equal(governed.zoneId,"blr-east");assert.doesNotMatch(governed.address,/560113/);
 assert.deepEqual(c.canonical(),before,"canonical address and PIN untouched");
});

test("observed column/text distinction with a DIFFERENT doorstep is not postal drift: identity conflict, nothing repaired",async t=>{
 const c=await fixture(t);const before=c.canonical();
 for(const text of ["Different building, unit 999, Bengaluru, 560113, India","99 Other Street, Kalyan Nagar & Banaswadi, Bengaluru, 560113, India"]){
  const seeded=c.seedGeocode({...OBSERVED,address_text:text});
  const answer=await refusal(resolve(c.db));
  assert.equal(answer.status,409);assert.match(answer.text,/^Address geocode identity conflict/,text);
  assert.deepEqual(c.geocode(),seeded,"untouched");
 }
 const columnDrift=c.seedGeocode({pincode:"560113",address_text:"99 Other Street, Kalyan Nagar & Banaswadi, Bengaluru, 560113, India"});
 const answer=await refusal(resolve(c.db));
 assert.match(answer.text,/^Address geocode identity conflict/,"PIN-column drift with a different doorstep is not disposable either (v7 repaired this)");
 assert.deepEqual(c.geocode(),columnDrift);assert.deepEqual(c.canonical(),before);
});

test("fresh geocoder evidence is validated BEFORE any write: a valid fresh answer repairs the observed shape",async t=>{
 const c=await fixture(t);const before=c.canonical();c.seedGeocode(OBSERVED);
 await withMockGeocoder(geocoderAnswer(FRESH_OK),async calls=>{
  const governed=await resolve(c.db);
  assert.equal(calls.length,1,"the unchanged canonical address was geocoded once");
  assert.equal(new URL(calls[0]).searchParams.get("address"),"7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, 560043, India","the request carried the canonical address, not the stale text");
  const row=c.geocode();
  assert.deepEqual([row.pincode,row.address_text,row.latitude,row.longitude],["560043",FRESH_OK,13.0213,77.6411]);
  assert.deepEqual([governed.latitude,governed.longitude],[13.0213,77.6411]);
 });
 assert.deepEqual(c.canonical(),before);
});

for(const [label,answer] of [
 ["fresh wrong PIN in the geocoder text",geocoderAnswer("7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, Karnataka 560113, India")],
 ["fresh wrong city",geocoderAnswer("7 Hennur Main Road, Kalyan Nagar & Banaswadi, Chennai, Tamil Nadu 560043, India")],
 ["fresh different doorstep",geocoderAnswer("99 Other Street, Kalyan Nagar & Banaswadi, Bengaluru, Karnataka 560043, India")],
 ["fresh invalid coordinates",geocoderAnswer(FRESH_OK,200,77.64)],
 ["fresh ZERO_RESULTS",{status:"ZERO_RESULTS",results:[]}],
]){
 test(`${label}: refused with NO write; old cache and canonical address preserved exactly`,async t=>{
  const c=await fixture(t);const before=c.canonical();
  for(const shape of [OBSERVED,{}]){
   const seeded=c.seedGeocode(shape);
   await withMockGeocoder(answer,async calls=>{
    const refused=await refusal(resolve(c.db));
    assert.equal(calls.length,1);assert.equal(refused.status,409);
    assert.doesNotMatch(refused.text,/identity conflict/i,"a contradictory map answer is a verification failure, not the customer's conflict");
    const {publicAddressRefusal}=await import("../lib/service-discovery-address.ts");
    const pub=publicAddressRefusal(refused.status,refused.text);
    assert.deepEqual([pub.code,pub.reason],["SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE","verification_unavailable"]);
    assert.doesNotMatch(pub.error,/not a problem|is correct|is right|wrong|invalid|Check the address and PIN/i,"neutral: neither blames nor clears the address");
   });
   assert.deepEqual(c.geocode(),seeded,"the old cache row is byte-for-byte unchanged");
  }
  assert.deepEqual(c.canonical(),before,"canonical address and PIN unchanged");
 });
}

test("fresh contradictory geocoder answer through the real route: verification_unavailable, no reservation, no booking, cache intact",async t=>{
 const c=await fixture(t);
 c.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT,vaccination_status TEXT,created_at INTEGER,updated_at INTEGER)");
 c.sqlite.prepare("INSERT OR REPLACE INTO canonical_customers(id,name,primary_phone,city_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(CANONICAL.customerId,"Repair Customer","9000800961","blr","active",Date.now(),Date.now());
 c.sqlite.prepare("INSERT OR REPLACE INTO canonical_pets(id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES ('REPAIR-P',?,'Milo','dog','verified',?,?)").run(CANONICAL.customerId,Date.now(),Date.now());
 const cookie=await sessionCookie(c.db,'customer',CANONICAL.customerId,`customer:${CANONICAL.customerId}`);
 const at=new Date(Date.now()+7*86400000);at.setUTCHours(4,30,0,0);
 const {POST}=await import("../app/api/uat-scheduling/route.ts");
 const seeded=c.seedGeocode(OBSERVED),before=c.canonical();
 await withMockGeocoder(geocoderAnswer("7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, Karnataka 560113, India"),async()=>{
  const response=await POST(new Request("https://uat.pawspace.in/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({action:"reserve",clientRequestId:"REPAIR-FRESH-BAD",customerId:CANONICAL.customerId,petIds:["REPAIR-P"],serviceCode:"dog_training",scheduledStart:at.toISOString(),scheduledEnd:new Date(at.getTime()+3600000).toISOString(),occurrences:1})}));
  const body=await response.json();
  assert.equal(response.status,409,JSON.stringify(body));assert.deepEqual([body.code,body.reason],["SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE","verification_unavailable"]);
  assert.deepEqual(Object.keys(body).sort(),["code","error","reason"]);assert.doesNotMatch(body.error,/560113|Hennur|googleapis|not a problem/);
 });
 const count=table=>c.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?c.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n:0;
 assert.equal(count("scheduling_reservations"),0);assert.equal(count("canonical_bookings"),0);
 assert.deepEqual(c.geocode(),seeded);assert.deepEqual(c.canonical(),before);
});

test("CANARY canonical-address race: line1/updated_at change immediately BEFORE the cache CAS refuses safely; nothing repaired over the new address",async t=>{
 const c=await fixture(t);const stale=c.seedGeocode(OBSERVED);
 const edited={line1:"8 Hennur Cross, Kalyan Nagar",updated_at:Date.now()+5};
 const db={prepare(sql){if(/^UPDATE customer_service_address_geocodes/.test(sql))c.sqlite.prepare("UPDATE customer_addresses SET line1=?,updated_at=? WHERE id=?").run(edited.line1,edited.updated_at,CANONICAL.id);return c.db.prepare(sql);},batch:statements=>c.db.batch(statements)};
 const answer=await refusal(resolve(db));
 assert.equal(answer.status,409);assert.match(answer.text,/^Saved address changed while it was being verified/);
 assert.deepEqual(c.geocode(),stale,"the guarded CAS matched nothing: the cache is not repaired from the superseded address");
 const now=c.canonical();assert.deepEqual([now.line1,now.updated_at,now.postal_code],[edited.line1,edited.updated_at,"560043"],"the customer's newer address stands; nothing reverted or rewritten");
 const {publicAddressRefusal}=await import("../lib/service-discovery-address.ts");
 assert.deepEqual(publicAddressRefusal(answer.status,answer.text).reason,"address_changed");
});

test("canonical-address race on a first geocode (no cache row): the guarded INSERT writes nothing and the request refuses",async t=>{
 const c=await fixture(t);
 const db={prepare(sql){if(/^INSERT INTO customer_service_address_geocodes/.test(sql))c.sqlite.prepare("UPDATE customer_addresses SET line1=?,updated_at=? WHERE id=?").run("8 Hennur Cross, Kalyan Nagar",Date.now()+5,CANONICAL.id);return c.db.prepare(sql);},batch:statements=>c.db.batch(statements)};
 const answer=await refusal(resolve(db));
 assert.match(answer.text,/^Saved address changed while it was being verified/);
 assert.equal(c.sqlite.prepare("SELECT COUNT(*) n FROM customer_service_address_geocodes").get().n,0);
});

test("canonical change after a valid cached read still blocks returning authority",async t=>{
 const c=await fixture(t);c.seedGeocode({pincode:"560043",address_text:"7 Hennur Main Road, Kalyan Nagar & Banaswadi, Bengaluru, 560043, India",latitude:13.01,longitude:77.63});
 let reads=0;
 const db={prepare(sql){if(/^SELECT customer_id,line1/.test(sql)&&++reads===1)c.sqlite.prepare("UPDATE customer_addresses SET updated_at=? WHERE id=?").run(Date.now()+9,CANONICAL.id);return c.db.prepare(sql);},batch:statements=>c.db.batch(statements)};
 const answer=await refusal(resolve(db));
 assert.match(answer.text,/^Saved address changed while it was being verified/);
});
