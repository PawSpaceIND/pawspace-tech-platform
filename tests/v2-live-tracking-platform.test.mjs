import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

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
