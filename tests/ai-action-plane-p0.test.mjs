import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8");

test("P0 AI mutations are canonical tools, not Ops case requests",()=>{
  const registry=read("lib/ai-tool-registry.ts");
  for(const tool of ["schedule.reserve","booking.create","checkout.payment_order.create","booking.reschedule","booking.cancel","provider.assignment.execute_policy"])
    assert.match(registry,new RegExp(tool.replaceAll(".","\\.")));
  for(const deprecated of ["booking.request","booking_reschedule.request","booking_cancel.request"])
    assert.doesNotMatch(registry,new RegExp(`code:\\"${deprecated.replaceAll(".","\\.")}\\"`));
  assert.match(registry,/\/api\/uat-scheduling/);
  assert.match(registry,/\/api\/canonical-bookings/);
  assert.match(registry,/\/api\/payment-order/);
  assert.match(registry,/\/api\/grooming-booking-change/);
});

test("financial authority remains gated while deterministic provider policy is AI-triggerable",()=>{
  const plane=read("lib/ai-first-control-plane.ts");
  assert.match(plane,/CONFIRMABLE_SAFE_MUTATIONS[^\n]+provider\.assignment\.execute_policy/);
  assert.doesNotMatch(plane,/NEVER_AUTONOMOUS_TOOLS[^\n]+provider\.assign/);
  for(const tool of ["refund.issue","payment.capture","payout.release","price.override"])
    assert.match(plane,new RegExp(`NEVER_AUTONOMOUS_TOOLS[^\\n]+${tool.replaceAll(".","\\.")}`));
});

test("public leads are AI-owned and no immediate human call task is created",()=>{
  const route=read("app/api/public-contact/route.ts");
  assert.match(route,/AI Orchestrator/);
  assert.match(route,/ai_lead_ownership/);
  assert.match(route,/max_clarifications[^\n]+DEFAULT 2/);
  assert.doesNotMatch(route,/First response to new website lead/);
  assert.doesNotMatch(route,/Call within 10 minutes/);
  assert.doesNotMatch(route,/INSERT INTO crm_tasks/);
});

test("payment order tool cannot mark money captured",()=>{
  const payment=read("lib/payment-order-intent.ts");
  assert.match(payment,/verified Razorpay webhook remains the only path that may mark booking money captured/);
  assert.doesNotMatch(payment,/UPDATE booking_payments SET status='captured'/);
});

test("AI-first leads clarify twice before low-confidence human escalation",()=>{
  const orchestrator=read("lib/ai-conversation-orchestrator.ts");
  const handoff=read("lib/ai-human-handoff.ts");
  assert.match(orchestrator,/max_clarifications INTEGER NOT NULL DEFAULT 2/);
  assert.match(orchestrator,/clarify:next<max/);
  assert.match(orchestrator,/escalate:next>=max/);
  assert.match(orchestrator,/high_value_enterprise_objection/);
  assert.match(handoff,/sales-hot/);
  assert.match(handoff,/status='human_escalated'/);
  assert.match(handoff,/INSERT OR IGNORE INTO crm_tasks/);
});

test("service-channel mutation delegation is thread/customer scoped and never borrows Finance authority",()=>{
  const plane=read("lib/ai-first-control-plane.ts");
  assert.match(plane,/executeGovernedConversationTool/);
  assert.match(plane,/Conversation tool customer\/thread mismatch/);
  assert.match(plane,/Human-owned or closed conversation cannot execute AI mutations/);
  assert.match(plane,/"scheduling.book","bookings.manage"/);
  assert.doesNotMatch(plane,/delegated[^\n]+finance\.manage/);
  assert.doesNotMatch(plane,/delegated[^\n]+payments\.manage/);
});

test("canonical route handlers expose server-only actor entrypoints while preserving normal POST auth",()=>{
  for(const [path,name] of [["app/api/uat-scheduling/route.ts","executeGovernedSchedulingRequest"],["app/api/canonical-bookings/route.ts","executeCanonicalBookingRequest"],["app/api/payment-order/route.ts","executePaymentOrderRequest"],["app/api/grooming-booking-change/route.ts","executeGroomingBookingChange"]]){const source=read(path);assert.match(source,new RegExp(name));assert.match(source,new RegExp(`export async function POST\\(request:Request\\).*${name}`));}
});
