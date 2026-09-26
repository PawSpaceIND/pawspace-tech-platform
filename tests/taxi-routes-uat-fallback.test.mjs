import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeTaxiRouteLeg } from "../lib/taxi-route-pricing.ts";

const env={PAWSPACE_MAPS_ENV:"sandbox",GOOGLE_MAPS_SERVER_API_KEY_UAT:"fixture-key"};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});

test("Taxi refuses provider failures instead of pricing a synthetic route",async()=>{
 for(const status of [401,403,429,500,503]){
  await assert.rejects(()=>computeTaxiRouteLeg(env,"Indiranagar Bengaluru","Whitefield Bengaluru",async()=>json({},status)),error=>error instanceof Response&&error.status===503);
 }
 await assert.rejects(()=>computeTaxiRouteLeg(env,"Indiranagar Bengaluru","Whitefield Bengaluru",async()=>json({},400)),error=>error instanceof Response&&error.status===409);
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

test('Taxi timeout refuses a quote instead of substituting distance',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=computeTaxiRouteLeg(env,'Indiranagar Bengaluru','Whitefield Bengaluru',async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
 const refused=assert.rejects(()=>pending,error=>error instanceof Response&&error.status===503);
 t.mock.timers.tick(8000);
 await refused;
});
