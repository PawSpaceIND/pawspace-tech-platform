import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeTaxiRouteLeg } from "../lib/taxi-route-pricing.ts";

const env={PAWSPACE_MAPS_ENV:"sandbox",GOOGLE_MAPS_SERVER_API_KEY_UAT:"fixture-key"};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});

test("Taxi UAT falls back deterministically when Google Routes is permission-blocked",async()=>{
 const route=await computeTaxiRouteLeg(env,"Indiranagar Bengaluru","Whitefield Bengaluru",async()=>json({error:{status:"PERMISSION_DENIED"}},403));
 assert.deepEqual(route,{distanceKm:10,durationMinutes:45,provider:"sandbox_route_fallback",providerReference:"google_routes_http_403"});
});

test("Taxi UAT falls back on provider 5xx but not customer-address 4xx",async()=>{
 const fallback=await computeTaxiRouteLeg(env,"Indiranagar Bengaluru","Whitefield Bengaluru",async()=>json({},503));
 assert.equal(fallback.provider,"sandbox_route_fallback");
 await assert.rejects(
   ()=>computeTaxiRouteLeg(env,"Indiranagar Bengaluru","Whitefield Bengaluru",async()=>json({},400)),
   error=>error instanceof Response&&error.status===409
 );
});

test("Taxi keeps a usable Google route authoritative",async()=>{
 const route=await computeTaxiRouteLeg(env,"Indiranagar Bengaluru","Whitefield Bengaluru",async()=>json({routes:[{distanceMeters:12340,duration:"1800s"}]}));
 assert.equal(route.provider,"google_routes_uat");
 assert.equal(route.distanceKm,12.34);
 assert.equal(route.durationMinutes,30);
});

test("Taxi fallback cannot activate outside the sandbox adapter",async()=>{
 await assert.rejects(
   ()=>computeTaxiRouteLeg({PAWSPACE_MAPS_ENV:"production",GOOGLE_MAPS_SERVER_API_KEY_UAT:"fixture-key"},"Indiranagar Bengaluru","Whitefield Bengaluru",async()=>json({},403)),
   error=>error instanceof Response&&error.status===409
 );
});

test("Taxi commercial quote persists the actual route source",()=>{
 const route=readFileSync(new URL("../app/api/taxi-commercial/route.ts",import.meta.url),"utf8");
 assert.match(route,/sandbox_route_fallback/);
 assert.match(route,/routeProvider=outbound\.provider/);
 assert.match(route,/productionMapsVerified:false/);
});
