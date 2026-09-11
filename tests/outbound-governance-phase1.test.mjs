import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { centralConsentAllows } from "../lib/communication-governance.ts";
const read=(path)=>fs.readFileSync(path,"utf8");
test("central governance module is executable",()=>assert.equal(typeof centralConsentAllows,"function"));
test("Phase 1 outbound throughput and governance contracts stay wired",()=>{
 const sweep=read("lib/outbound-sweep.ts"),scheduler=read("lib/diamond-crm-scheduler.ts"),engine=read("lib/communication-engine.ts"),governance=read("lib/communication-governance.ts");
 assert.match(sweep,/Math\.min\(2000,input\.batchSize\|\|1500\)/);
 assert.match(scheduler,/batchSize:1500/);
 assert.match(scheduler,/delegatedTo:"communication_outbox_dispatcher"/);
 assert.doesNotMatch(scheduler,/dispatchEmailOutbox\(/);
 assert.match(engine,/quiet_end_hour INTEGER NOT NULL DEFAULT 9/);
 assert.match(engine,/'comm_blr_default','blr',NULL,'enforce',21,9/);
 assert.match(governance,/communication_consent/);
 assert.match(governance,/channel==='voice'\?\{cap:1,window:14\*DAY\}/);
 assert.match(governance,/channel==='whatsapp'\?\{cap:2,window:7\*DAY\}/);
});
test("STOP and provider dispatches use centralized governance",()=>{
 const metaHook=read("lib/meta-whatsapp-webhook.ts"),interakt=read("lib/interakt-whatsapp-base.ts"),meta=read("lib/meta-whatsapp-dispatch.ts"),generic=read("lib/communication-provider-boundary.ts"),email=read("lib/crm-email-sync.ts"),voice=read("lib/voice-outbound-governance.ts");
 assert.match(metaHook,/recordGlobalOptOut/);assert.match(interakt,/recordGlobalOptOut/);
 assert.match(meta,/centralConsentAllows/);assert.match(interakt,/centralConsentAllows/);assert.match(generic,/centralConsentAllows/);assert.match(email,/centralConsentAllows/);assert.match(voice,/centralConsentAllows/);
 assert.match(meta,/reserveCommunicationFrequency/);assert.match(interakt,/reserveCommunicationFrequency/);
});
