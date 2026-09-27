import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {customerScopedHref,isV2CustomerPath} from "../lib/v2/route-scope.ts";
const read=rel=>fs.readFileSync(new URL(`../${rel}`,import.meta.url),"utf8");
test("V2 account reuses V1 billing, rewards, referrals and notification components",()=>{const page=read("app/v2/account/page.tsx");for(const token of ["AccountTools","ReferralCard","CustomerNotifications","/v2/support"])assert.ok(page.includes(token),token);});
test("V2 support uses canonical customer support case API",()=>{const page=read("app/v2/support/page.tsx");assert.match(page,/\/api\/customer-support-case/);assert.match(page,/loadV2CustomerAccount/);assert.match(page,/requestId:crypto\.randomUUID\(\)/);});
test("V2 routing module executes for parity coverage",()=>{assert.equal(isV2CustomerPath("/v2/team/people"),true);assert.equal(customerScopedHref("/v2/training","/training"),"/v2/training");});
