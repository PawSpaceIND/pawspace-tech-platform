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

const {resolveGovernedServiceAddress}=await import("../lib/service-discovery-address.ts");
for(const serviceCode of ["grooming","dog_training","boarding","pet_sitting","dog_walking","pet_taxi"])test(`publisher shared resolver exact-shape repair: ${serviceCode}`,async t=>{
 const c=await fixture(t),before=c.canonical();c.seedGeocode({pincode:"560043"});
 const answer=await resolveGovernedServiceAddress(c.db,{customerId:CANONICAL.customerId,serviceCode,saveToAccount:false});
 assert.equal(answer.pincode,"560043");assert.equal(answer.zoneId,"blr-east");assert.doesNotMatch(c.geocode().address_text,/560113/);assert.deepEqual(c.canonical(),before);
 assert.equal(c.sqlite.prepare("SELECT COUNT(*) n FROM customer_service_address_geocodes").get().n,1);
});

// The reviewed restoration guards live with the executed resolver controls; the static-test budget stays unchanged.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preservedServiceAddressV8Bytes} from './helpers/service-address-v8-reviewed-delta.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/service-address-v8-reviewed-delta.json',import.meta.url),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [path,entry] of Object.entries(receipt.files))test('v8 exact restoration and mutation refusal: '+path,()=>{
 const bytes=readFileSync(new URL('../'+path,import.meta.url));assert.equal(hash(bytes),entry.afterSha256);
 const before=preservedServiceAddressV8Bytes(path,bytes);assert.equal(hash(before),entry.beforeSha256);assert.equal(preservedServiceAddressV8Bytes(path,before),before);
 for(const mutated of [Buffer.concat([bytes,Buffer.from('\nUNREVIEWED')]),Buffer.from('X'+bytes.toString().slice(1)),bytes.subarray(1),Buffer.from(bytes.toString().replaceAll('\n','\r\n'))])assert.throws(()=>preservedServiceAddressV8Bytes(path,mutated));
 for(const [old,replacement] of entry.replacements){assert.equal(bytes.toString().split(replacement).length,2);assert.throws(()=>preservedServiceAddressV8Bytes(path,Buffer.from(bytes.toString().replace(replacement,replacement+'/* UNREVIEWED */'))));}
});
test('v8 preservation leaves unrelated files untouched',()=>{const bytes=Buffer.from('unchanged');assert.equal(preservedServiceAddressV8Bytes('lib/unrelated.ts',bytes),bytes);});
