import test from "node:test";
import assert from "node:assert/strict";
import { quoteGovernedCoupon } from "../lib/coupon-governance-client.ts";
test("coupon refusals preserve the server's eligibility explanation",async(t)=>{
  t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({data:{valid:false,error:"Coupon requires full payment",discount:0}}),{status:409}));
  await assert.rejects(()=>quoteGovernedCoupon({}),/Coupon requires full payment/);
});
test("base plus add-on gross value is sent unchanged and the server discount is retained",async(t)=>{
  t.mock.method(globalThis,"fetch",async(_url,options)=>{
    assert.equal(JSON.parse(options.body).input.orderValue,2398);
    return Response.json({data:{valid:true,code:"CARE100",quoteId:"q1",discount:100,finalAmount:2298}});
  });
  assert.equal((await quoteGovernedCoupon({orderValue:2398})).finalAmount,2298);
});
