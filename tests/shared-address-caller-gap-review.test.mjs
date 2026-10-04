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



// Characterization of inherited caller gaps, not product acceptance tests.
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
const require=createRequire(import.meta.url),ts=require("typescript");
const sourceRoot=path.resolve(path.dirname(new URL(import.meta.url).pathname),"..");
const {resolveServiceCoverage}=await import("../lib/service-zone-client.ts");
let stayJs=ts.transpileModule(fs.readFileSync(path.join(sourceRoot,"lib/stay-saved-address.ts"),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
for(const spec of ["./service-zone-client","./service-address-text"])stayJs=stayJs.replaceAll('"'+spec+'"',JSON.stringify(pathToFileURL(path.join(sourceRoot,"lib",spec+'.ts')).href));
const {validateSavedStayAddress}=await import("data:text/javascript;base64,"+Buffer.from(stayJs).toString("base64"));
const coverageBody={data:{zone:{zoneId:"blr-east",serviceAvailable:true},assignment:{pincode:"560038",zoneId:"blr-east",cityId:"blr",city:"Bengaluru",area:"Indiranagar"}}};
for(const raw of ["5600 38","5600389"]){test(`inherited gap: coverage helper normalizes malformed raw PIN ${raw}`,async t=>{
 const old=globalThis.fetch;let submitted;t.after(()=>globalThis.fetch=old);
 globalThis.fetch=async url=>{submitted=String(url);assert.ok(submitted.startsWith("/api/service-zone?"));return Response.json(coverageBody);};
 assert.equal((await resolveServiceCoverage(raw)).pincode,"560038");assert.equal(new URL(submitted,"http://localhost").searchParams.get("pincode"),"560038");
});}
test("inherited gap: saved Stay address normalizes malformed postal_code before validation",async t=>{
 const old=globalThis.fetch;let calls=0;t.after(()=>globalThis.fetch=old);
 globalThis.fetch=async url=>{calls++;assert.equal(new URL(String(url),"http://localhost").searchParams.get("pincode"),"560038");return Response.json(coverageBody);};
 const g=await validateSavedStayAddress({id:"LOCAL-ONLY",label:"Home",line1:"44 New Lane",area:"Indiranagar",city:"Bengaluru",postalCode:"5600 38",isDefault:true});
 assert.equal(g.assignment.pincode,"560038");assert.equal(calls,1);
});
test("inherited gap: unverified caller coordinates become cached authority when geocoder fails",async t=>{
 const c=await fixture(t),before=c.canonical(),env=globalThis.__GROOM_GOLDEN_ENV__,priorEnv={...env},priorFetch=globalThis.fetch;
 env.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE="off";env.GOOGLE_MAPS_SERVER_API_KEY_UAT="local-mocked-adapter";
 globalThis.fetch=async url=>{assert.equal(new URL(String(url)).hostname,"maps.googleapis.com");return Response.json({status:"ZERO_RESULTS",results:[]});};
 try{
  const g=await resolve(c.db,{serviceCode:"grooming",latitude:12.925,longitude:77.5938});
  assert.equal(g.latitude,12.925);assert.equal(g.longitude,77.5938);assert.equal(c.geocode().latitude,12.925);assert.deepEqual(c.canonical(),before);
  const picker=fs.readFileSync(path.join(sourceRoot,"app/mobile-app/address-picker.tsx"),"utf8"),grooming=fs.readFileSync(path.join(sourceRoot,"app/mobile-app/grooming-flow.tsx"),"utf8"),route=fs.readFileSync(path.join(sourceRoot,"app/api/grooming-service-location/route.ts"),"utf8");
  assert.match(picker,/latitude:place\?\.latitude\|\|12\.925/);assert.match(picker,/longitude:place\?\.longitude\|\|77\.5938/);assert.match(grooming,/latitude:\s*serviceLocation\.latitude/);assert.match(route,/source:"server_geocode"/);
 }finally{globalThis.fetch=priorFetch;for(const k of Object.keys(env))delete env[k];Object.assign(env,priorEnv);}
});
