import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import postcss from "postcss";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__G17_PRESENTATION_DB__");
const {providerCalendarSnapshot}=await import("../lib/provider-calendar-self-service.ts");
const read=path=>fs.readFileSync(path,"utf8");

test("G17 presentation contract loads the real calendar engine",()=>{ assert.equal(typeof providerCalendarSnapshot,"function"); });

test("G17 V2 reuses the canonical partner app and calendar component",()=>{
 const bridge=read("app/v2/partner/page.tsx"),page=read("app/partner-app/page.tsx");
 assert.match(bridge,/import PartnerPage from "..\/..\/partner-app\/page"/);
 assert.match(page,/import ProviderCalendarCard from "\.\/provider-calendar-card"/);
 assert.equal((page.match(/<ProviderCalendarCard /g)||[]).length,1);
 assert.match(page,/key=\{identity\.subjectId\} providerId=\{identity\.subjectId\}/);
});

test("G17 client calendar talks only to the ownership-scoped availability endpoint",()=>{
 const source=read("app/partner-app/provider-calendar-card.tsx");
 const urls=[...source.matchAll(/fetch\(([^,\n]+)/g)].map(match=>match[1]);
 assert.equal(urls.length,2);assert.ok(urls.every(value=>value.includes("provider-availability")));
 assert.doesNotMatch(source,/localStorage|sessionStorage|document\.cookie|providers\.manage|scheduling\.manage|dangerouslySetInnerHTML/);
 assert.match(source,/Only dates and time windows you explicitly mark/);
 assert.match(source,/Operations-managed dates cannot be widened/);
});

test("G17 API keeps ownership, commission-only self-service and Ops authority explicit",()=>{
 const route=read("app/api/provider-availability/route.ts"),engine=read("lib/provider-calendar-self-service.ts");
 assert.match(route,/await requireProviderOwnership\(db,actor,body\.providerId\)/);
 assert.match(route,/Use the Operations calendar controls for staff-managed availability/);
 assert.match(engine,/profile\.providerModel!==\"commission\"/);
 assert.match(engine,/source IN \('operations','roster'\)/);
 assert.match(engine,/source='partner_app'/);
 assert.match(engine,/DELETE FROM scheduling_availability WHERE provider_id=\? AND date=\? AND zone_id=\? AND source='partner_app'/);
 assert.doesNotMatch(engine,/fetch\(|WebSocket|sendBeacon/);
});

test("G17 calendar CSS stays scoped inside the existing partner viewport",()=>{
 const css=read("app/partner-app/partner.module.css"),start=css.indexOf(".viewport .calendarCard");
 assert.ok(start>0);const added=css.slice(start);
 postcss.parse(added).walkRules(rule=>assert.ok(rule.selector.split(",").every(part=>part.trim().startsWith(".viewport ")),"Unscoped G17 rule: "+rule.selector));
 assert.doesNotMatch(added,/display\s*:\s*none|visibility\s*:\s*hidden/);
});
