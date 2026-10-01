import test from "node:test";
import assert from "node:assert/strict";
import { mayaStayDescriptions } from "../lib/maya-stay-policy.ts";
test("model stay descriptions retain care choices without leaking fallback prices",()=>{
 const original=[{package_code:"boarding-4h",name:"Standard Stay",care_kind:"daycare",max_hours:4,base_price_per_pet:499,extra_pet_price:149,amountDueNow:499,price:{amount:499},description:"Care for 499 rupees",currency:"INR",version:1}];
 const result=mayaStayDescriptions(original);
 assert.deepEqual(result,[{package_code:"boarding-4h",name:"Standard Stay",care_kind:"daycare",max_hours:4,currency:"INR",version:1,pricingBasis:"available_provider_quote",bookingChannel:"customer_app"}]);
 assert.equal(original[0].base_price_per_pet,499,"canonical app catalogue is unchanged");
 assert.deepEqual(mayaStayDescriptions(undefined),[]);
 assert.deepEqual(mayaStayDescriptions([null,[],42]),[]);
});
