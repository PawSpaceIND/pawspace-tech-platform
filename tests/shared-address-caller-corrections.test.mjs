/**
 * Shared address callers, groups 1-3: the corrected behaviour the four inherited-gap characterisations
 * (tests/shared-address-caller-gap-review.test.mjs, which assert the OLD behaviour) no longer see.
 *
 *  1. Displayed and submitted address are one frozen selection: preview, reserve, replay and the post-booking
 *     doorstep save use it; a remembered draft never replaces it; the server binds the doorstep to the reservation.
 *  2. Strict raw PIN before any fetch or mutation, for typed and saved addresses, across the six scheduling services.
 *  3. Coordinates become map authority only through validated server map evidence, with honest provenance.
 *
 * Real helpers, real route handlers and the real resolver run against SQLite. Every map call is a stubbed fetch
 * with a placeholder key; nothing leaves the process. No test here claims a live Maps, notification or delivery result.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {setupJourney,runCompletedJourney,routeCall,sessionCookie} from "./helpers/grooming-journey-harness.mjs";
import {seedOwnedPet} from "./helpers/saved-pet-fixture.mjs";

const require=createRequire(import.meta.url),ts=require("typescript");
const sourceRoot=path.resolve(path.dirname(new URL(import.meta.url).pathname),"..");
const read=file=>fs.readFileSync(path.join(sourceRoot,file),"utf8");
const {resolveServiceCoverage,ServicePincodeInputError}=await import("../lib/service-zone-client.ts");
const {freezeServiceAddressSelection,withServiceAddress,doorstepSaveBody,serviceAddressSelectionKey}=await import("../lib/service-address-selection.ts");
const {reserveUatSchedule,previewUatProviders}=await import("../lib/uat-scheduling-client.ts");
// lib/stay-saved-address.ts uses extensionless imports; load it the same way the supplied characterisation does.
let stayJs=ts.transpileModule(read("lib/stay-saved-address.ts"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
for(const spec of ["./service-zone-client","./service-address-text"])stayJs=stayJs.replaceAll('"'+spec+'"',JSON.stringify(pathToFileURL(path.join(sourceRoot,"lib",spec+".ts")).href));
const {validateSavedStayAddress}=await import("data:text/javascript;base64,"+Buffer.from(stayJs).toString("base64"));

const coverageBody={data:{zone:{zoneId:"blr-east",serviceAvailable:true},assignment:{pincode:"560038",zoneId:"blr-east",cityId:"blr",city:"Bengaluru",area:"Indiranagar"}}};
const MALFORMED=[["letters","56003A"],["embedded space","5600 38"],["embedded punctuation","560-038"],["overlong","5600389"],["leading zero","060038"]];
const MISSING=["",'   '];

async function withFetch(handler,run){const prior=globalThis.fetch,calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):undefined});return handler(String(url),init);};try{return await run(calls);}finally{globalThis.fetch=prior;}}

// ---------------------------------------------------------------- group 2: strict raw PIN, before any fetch
for(const [label,raw] of [...MALFORMED,...MISSING.map(value=>["missing",value])]){
 test(`coverage helper (typed PIN; Grooming/Walking/Training/Stay/Sitting via the picker, Taxi and Food inputs): ${label} ${JSON.stringify(raw)} refused with no fetch`,async()=>{
  await withFetch(()=>Response.json(coverageBody),async calls=>{
   await assert.rejects(resolveServiceCoverage(raw),error=>error instanceof ServicePincodeInputError);
   assert.equal(calls.length,0,"the coverage API is never called with a malformed or missing PIN");
  });
 });
}
test("coverage helper: a valid PIN with only outer whitespace is trimmed and nothing else",async()=>{
 await withFetch(()=>Response.json(coverageBody),async calls=>{
  assert.equal((await resolveServiceCoverage("  560038 ")).pincode,"560038");
  assert.equal(new URL(calls[0].url,"http://local").searchParams.get("pincode"),"560038");
 });
});
const savedAddress=postalCode=>({id:"LOCAL-ONLY",label:"Home",line1:"44 New Lane, Indiranagar, Bengaluru 560038",area:"Indiranagar",city:"Bengaluru",postalCode,isDefault:true});
for(const [label,raw] of MALFORMED){
 test(`saved address (Stay/Sitting/Training saved-address path, Food direct pages): malformed saved postalCode ${label} refused, no fetch, no fallback to the PIN in the text`,async()=>{
  await withFetch(()=>Response.json(coverageBody),async calls=>{
   await assert.rejects(validateSavedStayAddress(savedAddress(raw)),/invalid PIN code/);
   assert.equal(calls.length,0);
  });
 });
}
test("saved address: a missing postalCode asks for the PIN and never extracts 560038 from the address text",async()=>{
 await withFetch(()=>Response.json(coverageBody),async calls=>{
  await assert.rejects(validateSavedStayAddress(savedAddress(null)),/Add the PIN code/);
  await assert.rejects(validateSavedStayAddress(savedAddress("  ")),/Add the PIN code/);
  assert.equal(calls.length,0);
 });
});
test("saved address: a valid saved PIN (outer whitespace only) resolves with one coverage call",async()=>{
 await withFetch(()=>Response.json(coverageBody),async calls=>{
  const resolved=await validateSavedStayAddress(savedAddress(" 560038 "));
  assert.equal(resolved.assignment.pincode,"560038");assert.equal(calls.length,1);
 });
});
test("frozen selection refuses malformed and missing PINs and incomplete addresses before any request is built",()=>{
 for(const [,raw] of MALFORMED)assert.throws(()=>freezeServiceAddressSelection({customerId:"C",address:"12 Long Street, Indiranagar",pincode:raw}),/valid six-digit PIN/);
 assert.throws(()=>freezeServiceAddressSelection({customerId:"C",address:"12 Long Street, Indiranagar",pincode:""}),/six-digit PIN code for this address/);
 assert.throws(()=>freezeServiceAddressSelection({customerId:"C",address:"short",pincode:"560038"}),/complete service address/);
});
test("caller sources keep raw PIN input and use the strict boundary (no stripping, truncation or area-name guessing)",()=>{
 const sources={picker:read("app/mobile-app/address-picker.tsx"),taxi:read("app/mobile-app/taxi-flow.tsx"),canonicalTaxi:read("app/taxi/canonical-taxi-page.tsx"),food:read("app/mobile-app/food-flow.tsx"),coverage:read("lib/service-zone-client.ts"),stay:read("lib/stay-saved-address.ts")};
 for(const [name,source] of Object.entries(sources)){
  assert.doesNotMatch(source,/pincode[^;\n]{0,80}replace\(\/\\D\/g,""\)/i,`${name}: no digit-stripping of a PIN`);
  assert.doesNotMatch(source,/postalCode[^;\n]{0,40}replace\(\/\\D\/g/,`${name}: no digit-stripping of a saved PIN`);
 }
 assert.doesNotMatch(sources.picker,/AREA_PIN|inferPin/,"no PIN guessed from an area name");
 assert.doesNotMatch(sources.stay,/match\(\/\\b\[1-9\]\\d\{5\}\\b\/\)/,"no saved-address PIN extracted from the text");
});

// Six scheduling services, typed and saved malformed PINs, through the real scheduling route.
const SERVICES=["grooming","dog_training","boarding","pet_sitting","pet_taxi","dog_walking"];
async function schedulingWorld(t){
 const ctx=await setupJourney();t.after(ctx.close);
 await seedOwnedPet(ctx.db,"PIN-C","PIN-P","Milo");
 const cookie=await sessionCookie(ctx.db,"customer","PIN-C","customer:PIN-C");
 const at=new Date(Date.now()+6*86400000);at.setUTCHours(4,30,0,0);
 const call=over=>routeCall("../../app/api/uat-scheduling/route.ts","POST","/api/uat-scheduling",{action:"reserve",clientRequestId:`PIN-${Math.random().toString(36).slice(2)}`,customerId:"PIN-C",petIds:["PIN-P"],scheduledStart:at.toISOString(),scheduledEnd:new Date(at.getTime()+3600000).toISOString(),...over},cookie);
 const count=table=>ctx.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?ctx.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n:0;
 return {...ctx,call,count};
}
test("scheduling route: typed malformed PIN refused for all six services before any reservation or address write",async t=>{
 const w=await schedulingWorld(t);
 for(const serviceCode of SERVICES)for(const [label,raw] of MALFORMED){
  const answer=await w.call({serviceCode,serviceAddress:"12 Long Street, Indiranagar, Bengaluru",servicePincode:raw});
  assert.equal(answer.status,400,`${serviceCode} ${label}: ${JSON.stringify(answer.body)}`);
  assert.deepEqual([answer.body.code,answer.body.reason],["SERVICE_ADDRESS_UNVERIFIED","pin_invalid"],`${serviceCode} ${label}`);
 }
 assert.equal(w.count("scheduling_reservations"),0);assert.equal(w.count("customer_addresses"),0);
});
test("scheduling route: a malformed SAVED postal code is refused for all six services and never rewritten",async t=>{
 const w=await schedulingWorld(t);
 w.sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES ('PIN-ADDR','PIN-C','Home','12 Long Street',NULL,'Indiranagar','Bengaluru','560 038',1,1,1)").run();
 for(const serviceCode of SERVICES){
  const answer=await w.call({serviceCode});
  assert.equal(answer.status,409,`${serviceCode}: ${JSON.stringify(answer.body)}`);
  assert.deepEqual([answer.body.code,answer.body.reason],["SERVICE_ADDRESS_UNVERIFIED","saved_pin_invalid"],serviceCode);
 }
 assert.equal(w.sqlite.prepare("SELECT postal_code FROM customer_addresses WHERE id='PIN-ADDR'").get().postal_code,"560 038");
 assert.equal(w.count("scheduling_reservations"),0);
});

// ---------------------------------------------------------------- group 1: one frozen selection
const A={address:"12 Rest House Road, Ashok Nagar, Bengaluru",pincode:"560025"};
const B={address:"7 Hennur Main Road, Kalyan Nagar, Bengaluru",pincode:"560043",latitude:13.02,longitude:77.64,verification:"map"};
async function withRememberedDraft(run){
 const priorWindow=globalThis.window;
 globalThis.window={sessionStorage:{getItem:key=>key==="pawspace.selected-service-address"?JSON.stringify(B):null}};
 try{return await run();}finally{globalThis.window=priorWindow;}
}
const okReserve=url=>Response.json({data:{groupId:"G",provider:{id:"p",name:"P",model:"full_time"},mode:"automatic",occurrences:[],explanation:[],providers:[],reserved:false,availabilityChecked:true}});
test("Grooming preview AND reserve carry displayed address A; remembered draft B (same city) is never submitted",async()=>{
 const frozen=freezeServiceAddressSelection({customerId:"C1",...A,cityId:"blr",zoneId:"blr-central"});
 await withRememberedDraft(()=>withFetch(okReserve,async calls=>{
  const base={clientRequestId:"groom-1",customerId:"C1",petIds:["P1"],serviceCode:"grooming",cityId:frozen.cityId,zoneId:frozen.zoneId,scheduledStart:"2026-10-10T04:30:00.000Z",scheduledEnd:"2026-10-10T06:30:00.000Z"};
  await previewUatProviders(withServiceAddress(base,frozen),{timeoutMs:2000}).catch(()=>undefined);
  await reserveUatSchedule(withServiceAddress(base,frozen));
  assert.equal(calls.length,2);
  for(const call of calls){
   assert.equal(call.body.serviceAddress,A.address);assert.equal(call.body.servicePincode,A.pincode);
   assert.equal(JSON.stringify(call.body).includes(B.address),false);assert.equal(JSON.stringify(call.body).includes(B.pincode),false);
   assert.equal(call.body.latitude,undefined,"no remembered coordinates");
  }
 }));
});
test("control: the same reserve WITHOUT the frozen pair would pick up draft B (why every covered caller sends A)",async()=>{
 await withRememberedDraft(()=>withFetch(okReserve,async calls=>{
  await reserveUatSchedule({clientRequestId:"groom-2",customerId:"C1",petIds:["P1"],serviceCode:"grooming",scheduledStart:"2026-10-10T04:30:00.000Z",scheduledEnd:"2026-10-10T06:30:00.000Z"});
  assert.equal(calls[0].body.serviceAddress,B.address);
 }));
});
test("legacy canonical Taxi reserve carries the quoted pickup A and its PIN; draft B is never submitted",async()=>{
 const frozen=freezeServiceAddressSelection({customerId:"C1",...A});
 await withRememberedDraft(()=>withFetch(okReserve,async calls=>{
  await reserveUatSchedule(withServiceAddress({clientRequestId:"taxi-Q1",customerId:"C1",petIds:["P1"],serviceCode:"pet_taxi",zoneId:"blr-central",scheduledStart:"2026-10-10T04:30:00.000Z",scheduledEnd:"2026-10-10T05:30:00.000Z",occurrences:1},frozen));
  assert.equal(calls[0].body.serviceAddress,A.address);assert.equal(calls[0].body.servicePincode,A.pincode);
 }));
 const page=read("app/taxi/canonical-taxi-page.tsx");
 assert.match(page,/setQuotedFor\(\{origin,pincode\}\)/,"the quote records the origin/PIN it was shown for");
 assert.match(page,/freezeServiceAddressSelection\(\{customerId:uatCustomer\.id,address:quotedFor\.origin,pincode:quotedFor\.pincode\}\)/);
 assert.match(page,/reserveUatSchedule\(withServiceAddress\(\{[^)]*serviceCode:"pet_taxi"[^)]*\},frozen\)\)/);
 assert.match(page,/\},\[routeCode,origin,destination,scheduledStart,pincode\]\);/,"a PIN change invalidates the quote");
});
test("an address or customer change during a delayed reserve cannot change the doorstep that is later saved",async()=>{
 const live={customerId:"C1",address:A.address,pincode:A.pincode,cityId:"blr",zoneId:"blr-central"};
 const frozen=freezeServiceAddressSelection(live);
 let release;const gate=new Promise(resolve=>{release=resolve;});
 await withFetch(async url=>{await gate;return okReserve(url);},async calls=>{
  const pending=reserveUatSchedule(withServiceAddress({clientRequestId:"groom-3",customerId:frozen.customerId,petIds:["P1"],serviceCode:"grooming",scheduledStart:"2026-10-10T04:30:00.000Z",scheduledEnd:"2026-10-10T06:30:00.000Z"},frozen));
  Object.assign(live,{customerId:"C2",address:B.address,pincode:B.pincode});// the form changes while the reserve is in flight
  release();await pending;
  assert.equal(calls[0].body.serviceAddress,A.address);
 });
 assert.ok(Object.isFrozen(frozen));
 assert.deepEqual(doorstepSaveBody(frozen,"BK-1"),{bookingId:"BK-1",customerId:"C1",address:A.address,pincode:A.pincode});
 assert.notEqual(serviceAddressSelectionKey(frozen),serviceAddressSelectionKey(freezeServiceAddressSelection(live)),"a different selection has a different identity");
 const grooming=read("app/mobile-app/grooming-flow.tsx");
 assert.match(grooming,/frozen=freezeServiceAddressSelection\(\{customerId:customer\.customerId,address:serviceLocation\.address,pincode:serviceLocation\.assignment\.pincode/);
 const reserve=grooming.slice(grooming.indexOf("decision=await reserveUatSchedule("),grooming.indexOf("const canonical=await createCanonicalLifecycle("));
 assert.ok(reserve.startsWith("decision=await reserveUatSchedule(withServiceAddress<UatScheduleRequest>({")&&reserve.includes('serviceCode:"grooming"')&&reserve.trimEnd().endsWith("},frozen));"),"the Grooming reserve is built from the frozen selection");
 assert.match(grooming,/await saveServiceLocation\(doorstepSaveBody\(frozen,canonical\.bookingId\)\);/);
 assert.match(grooming,/serviceLocation\.assignment\.zoneId,serviceLocation\.address,serviceLocation\.assignment\.pincode,/,"the request identity includes the address and PIN that the frozen selection submits");
});

function journeyConfig(overrides={}){
 const start=new Date(Date.now()+3*86_400_000);start.setUTCHours(3,30,0,0);
 return {customerId:"CUST-DOOR",customerName:"Anita",phone:"+919900000711",petSourceId:"PET-DOOR",petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"GROOM-DOOR",start:start.toISOString(),stopAfterCapture:true,...overrides};
}
const LOCATION="../../app/api/grooming-service-location/route.ts";
test("Grooming doorstep: the save is bound to the reservation's server-resolved doorstep; same-zone B is refused, A repeats idempotently",async t=>{
 const ctx=await setupJourney();t.after(ctx.close);
 const config=journeyConfig(),journey=await runCompletedJourney(ctx,config);
 assert.equal(journey.location.status,201,JSON.stringify(journey.location.body));
 const before={...ctx.sqlite.prepare("SELECT * FROM booking_service_locations WHERE booking_id=?").get(journey.bookingId)};
 assert.equal(before.source,"server_geocode");
 const decision=JSON.parse(ctx.sqlite.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").get(config.groupId).shortlist_json);
 assert.equal(decision.request.serviceAddressId,before.address_id,"the reservation recorded the governed doorstep the booking now uses");
 const other=await routeCall(LOCATION,"POST","/api/grooming-service-location",{bookingId:journey.bookingId,customerId:config.customerId,address:"Bina flat 9, Indiranagar",pincode:"560038"},journey.customerCookie);
 assert.equal(other.status,409,JSON.stringify(other.body));assert.equal(other.body.code,"booking_doorstep_mismatch");
 const forged=await routeCall(LOCATION,"POST","/api/grooming-service-location",{bookingId:journey.bookingId,customerId:config.customerId,address:"Bina flat 9, Indiranagar",pincode:"560038",addressId:before.address_id,serviceAddressId:before.address_id},journey.customerCookie);
 assert.equal(forged.status,409,"a client-claimed address id is not authority");
 const again=await routeCall(LOCATION,"POST","/api/grooming-service-location",{bookingId:journey.bookingId,customerId:config.customerId,address:`${config.customerName} service address`,pincode:config.pincode},journey.customerCookie);
 assert.equal(again.status,200,JSON.stringify(again.body));assert.equal(again.body.data.duplicatePrevented,true);
 assert.deepEqual({...ctx.sqlite.prepare("SELECT * FROM booking_service_locations WHERE booking_id=?").get(journey.bookingId)},before,"nothing was rewritten");
 const noPin=await routeCall(LOCATION,"POST","/api/grooming-service-location",{bookingId:journey.bookingId,customerId:config.customerId,address:`${config.customerName} service address 560038`},journey.customerCookie);
 assert.equal(noPin.status,400,"an absent PIN asks for one; none is extracted from the address text");
});
test("Grooming replay with a different doorstep under the same request id is refused; the original stands",async t=>{
 const ctx=await setupJourney();t.after(ctx.close);
 const config=journeyConfig({groupId:"GROOM-REPLAY",customerId:"CUST-REPLAY",petSourceId:"PET-REPLAY"}),journey=await runCompletedJourney(ctx,config);
 const start=new Date(config.start),end=new Date(start.getTime()+2*60*60_000);
 const replay=await routeCall("../../app/api/uat-scheduling/route.ts","POST","/api/uat-scheduling",{clientRequestId:config.groupId,customerId:config.customerId,petIds:[config.petSourceId],serviceCode:"grooming",cityId:"blr",zoneId:"blr-east",serviceAddress:"Bina flat 9, Indiranagar",servicePincode:"560038",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),preferredProviderId:config.preferredProviderId},journey.customerCookie);
 assert.equal(replay.status,409,JSON.stringify(replay.body));assert.equal(replay.body.code,"scheduling_group_address_conflict");
 const same=await routeCall("../../app/api/uat-scheduling/route.ts","POST","/api/uat-scheduling",{clientRequestId:config.groupId,customerId:config.customerId,petIds:[config.petSourceId],serviceCode:"grooming",cityId:"blr",zoneId:"blr-east",serviceAddress:`${config.customerName} service address`,servicePincode:"560038",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),preferredProviderId:config.preferredProviderId},journey.customerCookie);
 assert.equal(same.status,200,JSON.stringify(same.body));assert.equal(same.body.data.duplicatePrevented,true);
});
test("Grooming legacy booking: an existing doorstep is never overwritten by a different address",async t=>{
 const ctx=await setupJourney();t.after(ctx.close);
 const config=journeyConfig({groupId:"GROOM-LEGACY",customerId:"CUST-LEGACY",petSourceId:"PET-LEGACY"}),journey=await runCompletedJourney(ctx,config);
 // Simulate a legacy reservation group that recorded no doorstep: only the existing location protects it.
 const row=ctx.sqlite.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").get(config.groupId);
 const legacy=JSON.parse(row.shortlist_json);delete legacy.request.serviceAddressId;
 ctx.sqlite.prepare("UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?").run(JSON.stringify(legacy),config.groupId);
 const before={...ctx.sqlite.prepare("SELECT * FROM booking_service_locations WHERE booking_id=?").get(journey.bookingId)};
 const other=await routeCall(LOCATION,"POST","/api/grooming-service-location",{bookingId:journey.bookingId,customerId:config.customerId,address:"Bina flat 9, Indiranagar",pincode:"560038"},journey.customerCookie);
 assert.equal(other.status,409,JSON.stringify(other.body));assert.equal(other.body.code,"booking_doorstep_exists");
 assert.deepEqual({...ctx.sqlite.prepare("SELECT * FROM booking_service_locations WHERE booking_id=?").get(journey.bookingId)},before);
});

// ---------------------------------------------------------------- group 3: coordinate authority
const CANONICAL={id:"ADDR-GEO-1",customerId:"GEO-C",line1:"14 Indiranagar 100 Feet Road",area:"Indiranagar",city:"Bengaluru",postalCode:"560038"};
const CANONICAL_TEXT="14 Indiranagar 100 Feet Road, Indiranagar, Bengaluru, 560038, India";
async function geoWorld(t){
 const ctx=await setupJourney();t.after(ctx.close);
 ctx.sqlite.exec("CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,label TEXT NOT NULL,line1 TEXT NOT NULL,line2 TEXT,area TEXT,city TEXT NOT NULL,postal_code TEXT,is_default INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 ctx.sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1,1)").run(CANONICAL.id,CANONICAL.customerId,"Home",CANONICAL.line1,null,CANONICAL.area,CANONICAL.city,CANONICAL.postalCode);
 const rows=table=>ctx.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?ctx.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n:0;
 return {...ctx,rows};
}
async function resolveWith(db,over={}){const {resolveGovernedServiceAddress}=await import("../lib/service-discovery-address.ts");return resolveGovernedServiceAddress(db,{customerId:CANONICAL.customerId,serviceCode:"grooming",saveToAccount:false,...over});}
async function refusal(promise){try{await promise;assert.fail("expected a refusal");}catch(error){if(!(error instanceof Response))throw error;return {status:error.status,text:await error.text()};}}
/** Fixture off, placeholder (non-secret) key, both Google endpoints stubbed. */
async function withMaps({forward,reverse},run){
 const env=globalThis.__GROOM_GOLDEN_ENV__,prior={...env},priorFetch=globalThis.fetch,calls=[];
 env.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE="off";env.GOOGLE_MAPS_SERVER_API_KEY_UAT="local-mocked-adapter";
 globalThis.fetch=async url=>{const u=new URL(String(url));assert.equal(u.hostname,"maps.googleapis.com","no other network call");calls.push(u);return Response.json(u.searchParams.has("latlng")?reverse:forward);};
 try{return await run(calls);}finally{globalThis.fetch=priorFetch;for(const key of Object.keys(env))delete env[key];Object.assign(env,prior);}
}
const ZERO={status:"ZERO_RESULTS",results:[]};
const forwardOk=(text,lat=12.9784,lng=77.6408)=>({status:"OK",results:[{formatted_address:text,geometry:{location:{lat,lng}}}]});
const reverseOk=(text,pin)=>({status:"OK",results:[{formatted_address:text,address_components:[{types:["postal_code"],long_name:pin}]}]});
async function assertNoWrite(w,promise){
 const {publicAddressRefusal}=await import("../lib/service-discovery-address.ts");
 const answer=await refusal(promise);
 assert.equal(answer.status,409);
 const pub=publicAddressRefusal(answer.status,answer.text);
 assert.deepEqual([pub.code,pub.reason],["SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE","verification_unavailable"]);
 assert.doesNotMatch(pub.error,/Check the address and PIN|not a problem/);
 assert.equal(w.rows("customer_service_address_geocodes"),0,"no geocode written");
 assert.equal(w.rows("customer_service_address_geocode_provenance"),0,"no provenance written");
 assert.equal(w.rows("scheduling_reservations"),0);assert.equal(w.rows("booking_service_locations"),0);
}
test("typed address with no coordinates + geocoder ZERO_RESULTS: neutral refusal, nothing written",async t=>{
 const w=await geoWorld(t);
 await withMaps({forward:ZERO,reverse:ZERO},async calls=>{await assertNoWrite(w,resolveWith(w.db));assert.equal(calls.length,1,"only the forward geocode was asked");});
});
test("CORRECTED gap 4: the picker's old fixed point 12.925/77.5938 + ZERO_RESULTS no longer becomes cached authority",async t=>{
 const w=await geoWorld(t);
 await withMaps({forward:ZERO,reverse:ZERO},async()=>assertNoWrite(w,resolveWith(w.db,{latitude:12.925,longitude:77.5938})));
 const picker=read("app/mobile-app/address-picker.tsx");
 assert.doesNotMatch(picker,/12\.925|77\.5938/,"no invented typed-address coordinates");
 assert.match(picker,/latitude\?:number;longitude\?:number/,"a typed result carries no coordinates");
});
test("client-forged coordinates whose server reverse geocode names another PIN: refused, nothing written",async t=>{
 const w=await geoWorld(t);
 await withMaps({forward:ZERO,reverse:reverseOk("7 Hennur Main Road, Kalyan Nagar, Bengaluru, Karnataka 560043, India","560043")},async calls=>{
  await assertNoWrite(w,resolveWith(w.db,{latitude:13.02,longitude:77.64}));
  assert.equal(calls.filter(u=>u.searchParams.has("latlng")).length,1,"the device point was checked by the server, not trusted");
 });
});
test("client-forged coordinates whose reverse geocode carries the right PIN but a different doorstep: refused",async t=>{
 const w=await geoWorld(t);
 await withMaps({forward:ZERO,reverse:reverseOk("99 Other Street, Indiranagar, Bengaluru, Karnataka 560038, India","560038")},async()=>assertNoWrite(w,resolveWith(w.db,{latitude:12.97,longitude:77.64})));
});
test("geocoder answers with invalid coordinates: refused, nothing written",async t=>{
 const w=await geoWorld(t);
 await withMaps({forward:forwardOk(CANONICAL_TEXT,200,77.64),reverse:ZERO},async()=>assertNoWrite(w,resolveWith(w.db)));
});
test("verification flags, place ids and source labels sent by a client are not authority (location route)",async t=>{
 const ctx=await setupJourney();t.after(ctx.close);
 const config=journeyConfig({groupId:"GROOM-FLAGS",customerId:"CUST-FLAGS",petSourceId:"PET-FLAGS"});
 const journey=await runCompletedJourney(ctx,config);
 // Remove the recorded doorstep and its provenance so the next save must re-verify, then make map evidence unavailable.
 ctx.sqlite.prepare("DELETE FROM booking_service_locations WHERE booking_id=?").run(journey.bookingId);
 ctx.sqlite.prepare("DELETE FROM customer_service_address_geocode_provenance").run();
 await withMaps({forward:ZERO,reverse:ZERO},async()=>{
  const answer=await routeCall(LOCATION,"POST","/api/grooming-service-location",{bookingId:journey.bookingId,customerId:config.customerId,address:`${config.customerName} service address`,pincode:config.pincode,latitude:12.925,longitude:77.5938,verification:"map",placeId:"forged-place",coordinateSource:"server_geocode",source:"server_geocode"},journey.customerCookie);
  assert.equal(answer.status,409,JSON.stringify(answer.body));
  assert.deepEqual([answer.body.code,answer.body.reason],["SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE","verification_unavailable"]);
  assert.deepEqual(Object.keys(answer.body).sort(),["code","error","reason"],"no resolver or provider text leaves the route");
 });
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM booking_service_locations WHERE booking_id=?").get(journey.bookingId).n,0,"no booking location was written");
});
test("verified server forward geocode: coordinates come from the map answer and are recorded as server_geocode",async t=>{
 const w=await geoWorld(t);
 await withMaps({forward:forwardOk(CANONICAL_TEXT),reverse:ZERO},async()=>{
  const governed=await resolveWith(w.db,{latitude:12.925,longitude:77.5938});
  assert.deepEqual([governed.latitude,governed.longitude,governed.coordinateSource],[12.9784,77.6408,"server_geocode"],"client hint ignored when the server geocode succeeds");
 });
 assert.equal(w.sqlite.prepare("SELECT coordinate_source FROM customer_service_address_geocode_provenance").get().coordinate_source,"server_geocode");
 const cached=await resolveWith(w.db);
 assert.equal(cached.coordinateSource,"cached_geocode","a reused point is reported as cached on ordinary resolution");
 const persisted=await resolveWith(w.db,{requireCoordinateProvenance:true});
 assert.equal(persisted.coordinateSource,"server_geocode","when persisting a doorstep, the recorded provenance is reported");
});
test("current-location success: device point accepted only after the server's reverse geocode names this doorstep and PIN",async t=>{
 const w=await geoWorld(t);
 await withMaps({forward:ZERO,reverse:reverseOk(CANONICAL_TEXT,"560038")},async calls=>{
  const governed=await resolveWith(w.db,{latitude:12.9781,longitude:77.6402});
  assert.deepEqual([governed.latitude,governed.longitude,governed.coordinateSource],[12.9781,77.6402,"server_reverse_geocode"]);
  assert.equal(calls.length,2);
 });
 assert.equal(w.sqlite.prepare("SELECT coordinate_source FROM customer_service_address_geocode_provenance").get().coordinate_source,"server_reverse_geocode","provenance is recorded truthfully, never as server_geocode");
});
test("a legacy cached point with no recorded provenance is re-verified before it becomes a booking doorstep",async t=>{
 const w=await geoWorld(t);
 w.sqlite.exec("CREATE TABLE IF NOT EXISTS customer_service_address_geocodes (address_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pincode TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,resolved_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 const legacy={address_id:CANONICAL.id,customer_id:CANONICAL.customerId,pincode:"560038",city_id:"blr",zone_id:"blr-east",address_text:CANONICAL_TEXT,latitude:12.925,longitude:77.5938,resolved_at:1,updated_at:1};
 w.sqlite.prepare("INSERT INTO customer_service_address_geocodes VALUES (?,?,?,?,?,?,?,?,?,?)").run(...Object.values(legacy));
 assert.equal((await resolveWith(w.db)).coordinateSource,"cached_geocode","ordinary resolution reuses it (accepted v8 behaviour) but never calls it a server geocode");
 await withMaps({forward:ZERO,reverse:ZERO},async()=>{
  const answer=await refusal(resolveWith(w.db,{requireCoordinateProvenance:true}));
  assert.equal(answer.status,409,"no map evidence: the legacy point does not become a doorstep");
 });
 assert.deepEqual({...w.sqlite.prepare("SELECT * FROM customer_service_address_geocodes").get()},legacy,"and it is not overwritten");
 await withMaps({forward:forwardOk(CANONICAL_TEXT),reverse:ZERO},async()=>{
  const governed=await resolveWith(w.db,{requireCoordinateProvenance:true});
  assert.deepEqual([governed.latitude,governed.coordinateSource],[12.9784,"server_geocode"],"verified evidence replaces exactly that snapshot");
 });
});
