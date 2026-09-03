import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const lifecycle=await readFile(new URL("../lib/lead-lifecycle-governance.ts",import.meta.url),"utf8");
const attribution=await readFile(new URL("../lib/lead-conversion-attribution.ts",import.meta.url),"utf8");
const whatsapp=await readFile(new URL("../lib/whatsapp-uat-adapter.ts",import.meta.url),"utf8");
const crm=await readFile(new URL("../app/api/crm/route.ts",import.meta.url),"utf8");
const meta=await readFile(new URL("../lib/meta-lead-ads-ingestion.ts",import.meta.url),"utf8");
const metaRoute=await readFile(new URL("../app/api/leads/meta-webhook/route.ts",import.meta.url),"utf8");

test("lead business lifecycle is independent, guarded, and terminal",()=>{
 assert.match(lifecycle,/new:\["contacted","qualified","dropped"\]/);
 assert.match(lifecycle,/contacted:\["qualified","dropped"\]/);
 assert.match(lifecycle,/qualified:\["converted","dropped"\]/);
 assert.match(lifecycle,/converted:\[\]/);
 assert.match(lifecycle,/dropped:\[\]/);
 assert.match(lifecycle,/ALTER TABLE lead_work_items ADD COLUMN lifecycle_state/);
 assert.match(lifecycle,/Lead changed concurrently; reload before retrying/);
});

test("manual CRM ingestion creates canonical identity and a new lifecycle lead",()=>{
 assert.match(crm,/INSERT INTO canonical_customers/);
 assert.match(crm,/INSERT INTO lead_work_items[\s\S]*lifecycle_state/);
 assert.match(crm,/'active','new','day_1'/);
 assert.match(crm,/canonicalCustomerCreated:true/);
});

test("WhatsApp inbound cannot remain leadless",()=>{
 assert.match(whatsapp,/ensureInboundLead/);
 assert.match(whatsapp,/source:`whatsapp:\$\{provider\}`/);
 assert.match(whatsapp,/WhatsApp inbound could not initialize canonical lead tracking/);
 assert.match(whatsapp,/return\{duplicatePrevented:false as const,messageId,threadId,customerId,leadId/);
});

test("Meta Lead Ads webhook is signed, idempotent, identity-governed, and creates a lifecycle lead",()=>{
 assert.match(metaRoute,/verifyMetaWhatsAppSignature/);
 assert.match(metaRoute,/META_LEAD_ADS_GRAPH_VERSION/);
 assert.match(metaRoute,/authorization:`Bearer \$\{token\}`/);
 assert.doesNotMatch(metaRoute,/access_token=/);
 assert.match(meta,/meta_lead_ads_events \(leadgen_id TEXT PRIMARY KEY/);
 assert.match(meta,/meta_lead_ingestion_exceptions/);
 assert.match(meta,/ambiguous_customer_identity/);
 assert.match(meta,/ensureInboundLead/);
});

test("booking conversion normalizes service aliases and remains payment gated",()=>{
 assert.match(attribution,/normalizeLeadServiceCode/);
 assert.match(attribution,/customer_and_normalized_service/);
 assert.match(attribution,/booking_initiated/);
 assert.match(attribution,/lifecycle_state='converted'/);
 assert.match(attribution,/initiated_booking_id=\?/);
});
