import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {customerScopedHref,isV2CustomerPath} from "../lib/v2/route-scope.ts";
const files=["training/page.tsx","walking/page.tsx","food/canonical-food-page.tsx","food/subscriptions/page.tsx","food/subscription-payment/page.tsx","food/subscription-invoice/page.tsx","taxi/canonical-taxi-page.tsx","relocation/page.tsx"];
test("route scope keeps V1 unchanged and maps customer paths only inside V2",()=>{
 assert.equal(isV2CustomerPath("/v2/walking"),true);
 assert.equal(customerScopedHref("/walking","/walking/manage?bookingId=B1"),"/walking/manage?bookingId=B1");
 assert.equal(customerScopedHref("/v2/walking","/walking/manage?bookingId=B1"),"/v2/walking/manage?bookingId=B1");
 assert.equal(customerScopedHref("/v2/training","/mobile-app"),"/v2/account");
 assert.equal(customerScopedHref("/v2/taxi","/driver"),"/driver");
});
test("reused customer modules consume the V2 route-scope helper",()=>{for(const rel of files){const src=fs.readFileSync(new URL("../app/"+rel,import.meta.url),"utf8");assert.match(src,/customerScopedHref/);}});
test("V2 management routes bridge to canonical existing implementations",()=>{for(const rel of ["walking/manage","food/manage","food/subscriptions","food/subscription-payment","food/subscription-invoice","taxi/manage"]){const src=fs.readFileSync(new URL("../app/v2/"+rel+"/page.tsx",import.meta.url),"utf8");assert.match(src,/export \{default\} from/);}});
test("provider-only workspace links are conditional in V2 customer modules",()=>{const walking=fs.readFileSync(new URL("../app/walking/page.tsx",import.meta.url),"utf8");const taxi=fs.readFileSync(new URL("../app/taxi/canonical-taxi-page.tsx",import.meta.url),"utf8");assert.ok(walking.includes("!v2&&<Link href=\"/walker\""));assert.ok(taxi.includes("!v2&&<Link href={`/driver?bookingId="));});
