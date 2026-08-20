import test from "node:test";
import assert from "node:assert/strict";
import {malformedCanonicalPetIdentityResponse} from "../lib/canonical-pet-input-guard.ts";

function request(sourceId,{idempotencyKey="idem-new",scheduleGroupId="group-new"}={}){
  return new Request("https://pawspace.test/api/canonical-bookings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({idempotencyKey,scheduleGroupId,pets:[{sourceId,name:"O"}]})});
}
function db(existing=false){
  const calls=[];
  return {calls,prepare(sql){calls.push(sql);return{bind(...values){calls.push(values);return{async first(){return existing?{id:"BOOKING-HISTORICAL"}:null;}};}};}};
}
async function expectText400(sourceId){
  const fake=db(false);
  for(let attempt=0;attempt<10;attempt++){
    const response=await malformedCanonicalPetIdentityResponse(request(sourceId,{idempotencyKey:`idem-${attempt}`,scheduleGroupId:`group-${attempt}`}),fake);
    assert.equal(response?.status,400);
    assert.deepEqual(await response.json(),{error:"A pet source id must be text"});
  }
}

test("poisoned and ordinary non-text source ids fail closed as governed 400",async()=>{
  await expectText400({toString:"x"});
  await expectText400([{toString:"x"}]);
  await expectText400({valueOf:"x"});
  await expectText400({toString:null});
  await expectText400({id:"x"});
});

test("historical malformed identities bypass the preflight so route replay remains authoritative",async()=>{
  for(const half of [{idempotencyKey:"old-idem",scheduleGroupId:"new-group"},{idempotencyKey:"new-idem",scheduleGroupId:"old-group"}]){
    const fake=db(true);
    const response=await malformedCanonicalPetIdentityResponse(request({toString:"x"},half),fake);
    assert.equal(response,null);
    assert.equal(fake.calls.length,2);
  }
});

test("valid text and legacy blank classes remain owned by canonical route validation",async()=>{
  for(const value of ["7","","   ",null,[]])assert.equal(await malformedCanonicalPetIdentityResponse(request(value),db(false)),null);
  assert.equal(await malformedCanonicalPetIdentityResponse(request("bad\u0001id"),db(false)),null);
});
