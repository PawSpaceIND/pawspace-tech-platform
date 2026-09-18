import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {importLibModule} from "./helpers/ts-module-loader.mjs";
const hub=fs.readFileSync(new URL("../app/v2/workspaces/page.tsx",import.meta.url),"utf8");
test("workspace hub regression executes canonical support-case policy",async()=>{const {isSupportCaseOpen}=await importLibModule("support-case-status");assert.equal(isSupportCaseOpen("open"),true);assert.equal(isSupportCaseOpen("closed"),false);});
test("V2 workspace hub exposes customer partner CRM control center and AI entry points",()=>{for(const href of ["/v2","/v2/partner","/v2/crm","/v2/control-center","/v2/chat"])assert.match(hub,new RegExp('href:"'+href.replaceAll("/","\\/")+'"'));});
test("workspace bridges reuse the canonical screens and layouts",()=>{const partner=fs.readFileSync(new URL("../app/v2/partner/page.tsx",import.meta.url),"utf8"),crm=fs.readFileSync(new URL("../app/v2/crm/page.tsx",import.meta.url),"utf8"),control=fs.readFileSync(new URL("../app/v2/control-center/page.tsx",import.meta.url),"utf8");assert.match(partner,/PartnerMobileLayout/);assert.match(partner,/PartnerPage/);assert.match(crm,/CrmLayout/);assert.match(crm,/CrmPage/);assert.match(control,/booking-command-center/);});
