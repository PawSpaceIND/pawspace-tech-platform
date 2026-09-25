import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";

installWorkersHooks("__LIVE_STATIC_MAP_DB__","__LIVE_STATIC_MAP_ENV__");
globalThis.__LIVE_STATIC_MAP_ENV__={};
const{liveStaticMapResponse}=await import("../lib/live-static-map.ts");

const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");

test("V2 live tracking has one reusable multi-role presentation core",()=>{
 const panel=read("app/components/live-tracking/live-tracking-panel.tsx");
 assert.match(panel,/LIVE TRACKING/);
 assert.match(panel,/Recenter live map/);
 assert.match(panel,/etaMinutes/);
 assert.match(panel,/distanceKm/);
 assert.match(panel,/providerLabel/);
});

test("customer live map stays privacy projected and draws the governed route",()=>{
 const route=read("app/api/customer-grooming-summary/route.ts");
 const helper=read("lib/live-static-map.ts");
 assert.match(route,/privacyRounded:true/);
 assert.match(route,/route_eta_snapshots/);
 assert.match(route,/detail\.polyline/);
 assert.match(helper,/provider-rounded-3dp/);
 assert.match(helper,/path/);
 assert.match(helper,/encoded|enc:/);
});

test("partner live route uses provider-owned exact map and navigation without exposing a browser key",()=>{
 const api=read("app/api/grooming-route/route.ts");
 const card=read("app/partner-app/grooming-route-card.tsx");
 const helper=read("lib/live-static-map.ts");
 assert.match(api,/privacyRounded:false/);
 assert.match(card,/LiveTrackingPanel/);
 assert.match(card,/Open navigation/);
 assert.match(card,/map=1/);
 assert.doesNotMatch(card,/GOOGLE_MAPS_SERVER_API_KEY/);
 assert.match(helper,/GOOGLE_MAPS_SERVER_API_KEY_UAT/);
});

test("Ops exposes canonical live sessions and recovery exceptions, not raw customer GPS",()=>{
 const page=read("app/team/operations/live-tracking/page.tsx");
 const hub=read("app/team/operations/page.tsx");
 assert.match(page,/\/api\/location-recovery/);
 assert.match(page,/Active location sessions/);
 assert.match(page,/Recovery attention/);
 assert.match(page,/Raw GPS history is deliberately not rendered here/);
 assert.match(hub,/\/team\/operations\/live-tracking/);
});

test("live static map helper refuses bad input, keeps the key server-side and rounds only customer views",async t=>{
 const env=globalThis.__LIVE_STATIC_MAP_ENV__,realFetch=globalThis.fetch,calls=[];
 t.after(()=>{globalThis.fetch=realFetch;delete env.GOOGLE_MAPS_SERVER_API_KEY_UAT;});
 const provider={lat:12.971234,lng:77.594567},destination={lat:12.98,lng:77.6};
 assert.equal((await liveStaticMapResponse({provider:{lat:Number.NaN,lng:77.5},destination})).status,409,"malformed coordinates never reach Google");
 delete env.GOOGLE_MAPS_SERVER_API_KEY_UAT;
 assert.equal((await liveStaticMapResponse({provider,destination})).status,503,"a missing key is a configuration refusal");
 env.GOOGLE_MAPS_SERVER_API_KEY_UAT="uat-test-key";
 globalThis.fetch=async url=>{calls.push(new URL(String(url)));return new Response(new Uint8Array([137,80,78,71]),{status:200,headers:{"content-type":"image/png"}});};
 const customer=await liveStaticMapResponse({provider,destination,polyline:"abc~def",privacyRounded:true});
 assert.equal(customer.status,200);
 assert.equal(customer.headers.get("x-pawspace-location-privacy"),"provider-rounded-3dp");
 assert.equal(customer.headers.get("x-pawspace-map-source"),"google-static-maps");
 assert.equal(JSON.stringify([...customer.headers]).includes("uat-test-key"),false,"the server key never reaches the browser");
 const sent=calls[0];
 assert.equal(sent.origin+sent.pathname,"https://maps.googleapis.com/maps/api/staticmap");
 assert.ok(sent.searchParams.getAll("markers").some(m=>m.endsWith("|12.971,77.595")),"customer view rounds the provider to 3dp");
 assert.ok(sent.searchParams.getAll("path").some(p=>p.endsWith("enc:abc~def")),"the stored Routes polyline is drawn");
 const partner=await liveStaticMapResponse({provider,destination,privacyRounded:false});
 assert.equal(partner.headers.get("x-pawspace-location-privacy"),"provider-owned-exact");
 assert.ok(calls[1].searchParams.getAll("markers").some(m=>m.endsWith("|12.971234,77.594567")),"the provider sees their own exact position");
 assert.equal(calls[1].searchParams.getAll("path").length,0,"no path without a stored polyline");
 globalThis.fetch=async()=>new Response("denied",{status:403});
 assert.equal((await liveStaticMapResponse({provider,destination,privacyRounded:true})).status,502,"a Google refusal is a gateway failure, not an image");
});
