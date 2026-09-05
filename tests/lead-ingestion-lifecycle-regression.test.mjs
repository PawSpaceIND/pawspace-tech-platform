import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=(path)=>fs.readFileSync(path,"utf8");

test("lead lifecycle governance is persisted, normalized and compare-and-set",async()=>{
  const source=read("lib/lead-lifecycle-governance.ts");
  assert.match(source,/export type LeadLifecycleState/);
  assert.match(source,/lifecycle_state TEXT NOT NULL DEFAULT 'new'/);
  assert.match(source,/export function normalizeLeadServiceCode/);
  assert.match(source,/UPDATE lead_work_items SET lifecycle_state=\?,updated_at=\? WHERE id=\? AND lifecycle_state=\?/);
  assert.match(source,/export async function ensureInboundLead/);

  const lifecycle=await import("../lib/lead-lifecycle-governance.ts");
  assert.equal(lifecycle.normalizeLeadServiceCode("Dog Training"),"training");
  assert.equal(lifecycle.normalizeLeadServiceCode("pet-sitting"),"pet_sitting");
  assert.equal(lifecycle.normalizeLeadServiceCode("WhatsApp"),"general_inquiry");
});

test("lead conversion attribution uses normalized service and lifecycle state",()=>{
  const source=read("lib/lead-conversion-attribution.ts");
  assert.match(source,/normalizeLeadServiceCode\(booked\?\.service_code\)/);
  assert.match(source,/lifecycle_state NOT IN \('converted','dropped'\)/);
  assert.match(source,/lifecycle_state='converted'/);
  assert.match(source,/matchedOn:"customer_and_normalized_service"/);
});

test("leadless WhatsApp inbound initializes canonical lead before persisting message",()=>{
  const source=read("lib/whatsapp-uat-adapter.ts");
  assert.match(source,/assignLeadOwner\(db,\{customerId,service:"general_inquiry"\}\)/);
  assert.match(source,/ensureInboundLead\(db,\{customerId,source:`whatsapp:\$\{provider\}`/);
  assert.match(source,/if\(!leadId\)throw new Error\("WhatsApp inbound could not initialize canonical lead tracking"\)/);
  assert.match(source,/JSON\.stringify\(\{\.\.\.detail,leadId\}\)/);
});
