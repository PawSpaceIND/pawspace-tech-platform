import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__V2_BOARDING_TAXI_DB__");
const {renderToStaticMarkup}=await import("react-dom/server");
const {default:Page}=await import("../app/v2/taxi/page.tsx");
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("V2 Boarding Taxi entry preserves the exact source and waits for the signed-in account",async()=>{
 const sourceBookingId="PS-UAT-BOARDING&second=value";
 const element=await Page({searchParams:Promise.resolve({sourceBookingId})});
 assert.equal(element.props.sourceBookingId,sourceBookingId);
 const html=renderToStaticMarkup(element);
 assert.match(html,/Add Pet Taxi to your Boarding stay/);
 assert.match(html,/Loading your PawSpace family/);
 assert.ok(html.includes('/v2/boarding/manage?bookingId='+encodeURIComponent(sourceBookingId)));
 assert.doesNotMatch(html,/Create canonical UAT trip|TST-101|Reserve ·|\/mobile-app/);
});

test("ordinary V2 Taxi entry uses the same authenticated customer ride flow without a cross-sell source",async()=>{
 for(const sourceBookingId of [undefined,"", "  ",["one","two"]]){
  const element=await Page({searchParams:Promise.resolve({sourceBookingId})});
  const html=renderToStaticMarkup(element);
  assert.match(html,/Plan your Pet Taxi ride/);
  assert.match(html,/Loading your PawSpace family/);
  assert.doesNotMatch(html,/UAT route class|sandbox_deferred|Indiranagar UAT pickup/);
  assert.equal(element.props.sourceBookingId,undefined);
 }
});

test("V2 scope reaches Boarding management and confirmed-stay Taxi links, while V1 remains supported",()=>{
 assert.match(read("app/v2/stay-experience.tsx"),/<StayFlow routeScope="v2"/);
 assert.match(read("app/boarding/manage/page.tsx"),/<BoardingCustomerStayPanel[^>]*routeScope=\{routeScope\}/);
 for(const path of ["app/mobile-app/stay-flow.tsx","app/mobile-app/boarding-customer-stay-panel.tsx"]){
  const source=read(path);
  assert.match(source,/routeScope="legacy"/);
  assert.ok(source.includes('routeScope==="v2"?`/v2/taxi?sourceBookingId=${encodeURIComponent(bookingId)}`:`/mobile-app?service=pet_taxi&sourceBookingId=${encodeURIComponent(bookingId)}`'));
 }
 const entry=read("app/v2/taxi/boarding-taxi-experience.tsx");
 assert.match(entry,/loadCustomerAccount\(undefined/);
 assert.match(entry,/<TaxiFlow[^>]*sourceBookingId=\{sourceBookingId\}/);
 assert.doesNotMatch(entry,/createCanonicalTaxiBooking|sandbox_deferred/);
});
