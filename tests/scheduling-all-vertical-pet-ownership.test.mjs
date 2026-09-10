import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {setupJourney, sessionCookie} from "./helpers/grooming-journey-harness.mjs";

async function reserve(body, cookie) {
  const {POST} = await import("../app/api/uat-scheduling/route.ts");
  const response = await POST(new Request("https://uat.pawspace.in/api/uat-scheduling", {method:"POST", headers:{"content-type":"application/json", cookie}, body:JSON.stringify(body)}));
  return {status:response.status, body:await response.json()};
}
function rows(sqlite, table) {
  return sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) ? sqlite.prepare(`SELECT * FROM ${table}`).all() : [];
}
async function world(t, serviceCode) {
  const ctx = await setupJourney(); t.after(ctx.close);
  ctx.sqlite.exec(readFileSync(new URL("../app/api/walking-bookings/route.ts", import.meta.url), "utf8").match(/CREATE TABLE IF NOT EXISTS canonical_pets [^"\n]+/)[0]);
  for (const [id, owner] of [["MY-PET","CUSTOMER-A"],["FOREIGN-PET","CUSTOMER-B"]]) ctx.sqlite.prepare("INSERT INTO canonical_pets(id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES (?,?,?,'dog','verified',?,?)").run(id,owner,id,Date.now(),Date.now());
  const cookie = await sessionCookie(ctx.db,"customer","CUSTOMER-A","customer:CUSTOMER-A");
  const start = new Date(Date.now()+9*86400000); start.setUTCHours(5,30,0,0);
  const duration = serviceCode==="boarding" ? 86400000 : serviceCode==="grooming" ? 7200000 : 3600000;
  const body = {clientRequestId:`OWNED-${serviceCode}`,customerId:"CUSTOMER-A",petIds:["MY-PET"],serviceCode,serviceAddress:"42 Test Road, Indiranagar, Bengaluru 560038",servicePincode:"560038",scheduledStart:start.toISOString(),scheduledEnd:new Date(start.getTime()+duration).toISOString(),occurrences:1,...(serviceCode==="dog_training" ? {preferredProviderId:"train_kiran"} : {}),...(serviceCode==="pet_sitting" ? {preferredProviderId:"sit_sana",careMode:"visit"} : {}),...(serviceCode==="boarding" ? {preferredProviderId:"host_maya_rohan"} : {})};
  return {...ctx,cookie,body};
}
for (const service of ["grooming","dog_training","pet_taxi","pet_sitting","boarding"]) {
  test(`${service}: owned saved pet reserves and retries exactly once`, async t => {
    const {sqlite,cookie,body} = await world(t,service);
    const first=await reserve(body,cookie); assert.equal(first.status,200,JSON.stringify(first.body));
    const before=rows(sqlite,"scheduling_reservations"); assert.equal(before.length,1);
    const retry=await reserve(body,cookie); assert.equal(retry.status,200,JSON.stringify(retry.body)); assert.equal(retry.body.data.duplicatePrevented,true);
    assert.deepEqual(rows(sqlite,"scheduling_reservations"),before);
    assert.deepEqual(JSON.parse(before[0].pet_ids_json),["MY-PET"]);
  });
  for (const [label,petIds,status] of [["foreign pet",["FOREIGN-PET"],403],["missing pet",["MISSING"],403],["mixed ownership",["MY-PET","FOREIGN-PET"],403],["duplicate pet",["MY-PET","MY-PET"],400],["scalar IDs","MY-PET",400]]) {
    test(`${service}: ${label} is refused without holding capacity or dispatching`, async t => {
      const {sqlite,cookie,body}=await world(t,service);
      const result=await reserve({...body,petIds},cookie); assert.equal(result.status,status,JSON.stringify(result.body));
      for(const table of ["scheduling_reservations","scheduling_assignment_decisions","provider_assignment_offers"]) assert.equal(rows(sqlite,table).length,0,table);
    });
  }
}
