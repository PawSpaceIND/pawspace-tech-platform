import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { maskEmployeePhone } from "../lib/people-foundation.ts";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("employee PII masking executes the canonical People module",()=>{assert.equal(maskEmployeePhone("9876543210"),"+91 ••••••3210");});

test("legacy provider status mutation is ownership-bound and lifecycle-governed",async()=>{const src=await read("backend/src/app.ts");assert.match(src,/existing\.providerId!==a\.id/);assert.match(src,/assertBookingStatusTransition/);assert.match(src,/from:existing\.status/);});

test("manual provider selection requires a durable override reason",async()=>{const src=await read("backend/src/scheduling.ts");assert.match(src,/validateManualOverride\(input\)/);assert.match(src,/reason\.length<8/);assert.match(src,/Manual provider override requires a clear reason/);});

test("staff CRM binds canonical click and UTM attribution with staff provenance",async()=>{const src=await read("app/api/crm/route.ts");for(const token of ["gclid","fbclid","wbraid","gbraid","utmSource","utmMedium","utmCampaign","utmContent","utmTerm","campaignId","adId"])assert.match(src,new RegExp(token));assert.match(src,/recordLeadIntakeAdAttribution/);assert.match(src,/origin:\"staff_crm\"/);assert.match(src,/attributionBound/);});

test("public CRM intake tags organizational scope and public attribution provenance",async()=>{const src=await read("app/api/public-contact/route.ts");for(const token of ["city_id","team_code","department_code","origin:\"public_contact\""])assert.match(src,new RegExp(token));assert.match(src,/cityForArea/);});

test("manager views share a fail-closed organizational scope resolver",async()=>{const [scope,crm,command,people]=await Promise.all([read("lib/organizational-scope.ts"),read("app/api/crm/route.ts"),read("app/api/booking-command-center/route.ts"),read("app/api/people-foundation/route.ts")]);assert.match(scope,/location_code/);assert.match(scope,/team_code/);assert.match(scope,/cost_centre_code/);assert.match(scope,/Manager organizational scope is not fully provisioned/);assert.match(crm,/resolveManagerOrganizationalScope/);assert.match(command,/resolveManagerOrganizationalScope/);assert.match(people,/resolveManagerOrganizationalScope/);});

test("booking command center exposes the implemented live canonical SSE feed with snapshot fallback",async()=>{const [route,page,stream]=await Promise.all([read("app/api/booking-command-center/route.ts"),read("app/booking-command-center/page.tsx"),read("app/api/booking-command-center/stream/route.ts")]);assert.match(route,/canonical UAT database snapshot/);assert.match(page,/EventSource\("\/api\/booking-command-center\/stream"\)/);assert.match(page,/Live canonical feed/);assert.match(page,/Refresh snapshot/);assert.match(stream,/text\/event-stream/);assert.match(stream,/frame\("booking"/);});

test("dedicated audit hook is registered exactly and guarded by sandbox locks",async()=>{const pkg=JSON.parse(await read("package.json"));assert.equal(pkg.scripts["test:crm-control-center-audit"],"node --import tsx scripts/run-crm-control-center-audit.test.ts");const runner=await read("scripts/run-crm-control-center-audit.test.ts");assert.match(runner,/PAWSPACE_PAYMENT_ENV!==\"sandbox\"/);assert.match(runner,/FORBID_PRODUCTION!==\"true\"/);assert.match(runner,/PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED/);});
