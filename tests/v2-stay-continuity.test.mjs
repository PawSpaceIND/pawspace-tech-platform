import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {importLibModule} from "./helpers/ts-module-loader.mjs";
const home=fs.readFileSync(new URL("../app/v2/page.tsx",import.meta.url),"utf8");
const stay=fs.readFileSync(new URL("../app/v2/stay-experience.tsx",import.meta.url),"utf8");
test("V2 stay shell regression executes shared stay search state",async()=>{const {staySearchKey}=await importLibModule("stay-search-state");assert.match(staySearchKey({cityId:"blr",zoneId:"blr-east",location:"x",start:"2026-09-20",end:"2026-09-21",careWindow:"overnight",startTime:"09:00",petIds:["P1"],species:["dog"]}),/blr/);});
test("Boarding and Sitting stay inside V2",()=>{assert.match(home,/href: "\/v2\/boarding"/);assert.match(home,/href: "\/v2\/sitting"/);assert.match(stay,/StayFlow/);assert.match(stay,/loadCustomerAccount/);});
test("V2 stay shell reuses canonical engine rather than duplicating booking APIs",()=>{assert.doesNotMatch(stay,/fetch\(/);assert.match(stay,/CustomerLogin/);assert.match(stay,/mode=\{mode\}/);});
