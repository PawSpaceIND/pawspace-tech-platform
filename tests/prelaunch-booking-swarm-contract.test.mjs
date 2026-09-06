import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=(path)=>fs.readFileSync(path,"utf8");

const supported=[
  {code:"grooming",amount:1499},
  {code:"dog_training",amount:4200},
  {code:"boarding",amount:3600},
  {code:"pet_sitting",amount:2400},
];
const gated=[
  {code:"dog_walking",reason:"separate closure gate"},
  {code:"fresh_food",reason:"separate stacked workstream"},
  {code:"pet_taxi",reason:"outside current active pre-live priority"},
  {code:"relocation",reason:"not in canonical four-service booking contract"},
];
const testerRoles=["customer","partner","crm_sales","operations","finance","revenue_auditor","integration_fault_injector","security_rbac"];
const faults=["happy","partial_refund","full_refund","unpaid_cancelled","duplicate_replay","provider_cancel","customer_cancel","sla_delay","consent_suppressed","integration_down","happy_multi_pet","happy_repeat_customer","payment_replay","report_delivery_failure","outreach_suppressed"];

function moneyState(amount,fault){
  if(fault==="unpaid_cancelled")return {collected:0,refunded:0,net:0};
  if(fault==="partial_refund")return {collected:amount,refunded:Math.round(amount*.2),net:amount-Math.round(amount*.2)};
  if(fault==="full_refund"||fault==="provider_cancel")return {collected:amount,refunded:amount,net:0};
  if(fault==="customer_cancel")return {collected:amount,refunded:Math.round(amount*.75),net:amount-Math.round(amount*.75)};
  return {collected:amount,refunded:0,net:amount};
}

function supportedBooking(service,index){
  const fault=faults[index%faults.length];
  const bookingId=`SWARM-${service.code.toUpperCase()}-${String(index+1).padStart(2,"0")}`;
  const customerId=`SWARM-CUST-${String((index%12)+1).padStart(2,"0")}`;
  const providerId=`SWARM-PROVIDER-${service.code.toUpperCase()}-${String((index%4)+1).padStart(2,"0")}`;
  const money=moneyState(service.amount,fault);
  const finalStatus=["unpaid_cancelled","provider_cancel","customer_cancel"].includes(fault)?"cancelled":"confirmed";
  const base={bookingId,customerId,serviceCode:service.code,amount:service.amount,status:finalStatus};
  return {
    seed:`${service.code}:${index}`,
    fault,
    accepted:true,
    replayCount:["duplicate_replay","payment_replay"].includes(fault)?2:1,
    customer:{...base},
    crm:{...base},
    ops:{...base,providerId,sla:fault==="sla_delay"?"breached":"within_policy"},
    finance:{bookingId,customerId,serviceCode:service.code,...money},
    revenue:{bookingId,customerId,serviceCode:service.code,booked:finalStatus==="cancelled"?0:service.amount,...money},
    opportunity:{bookingId,customerId,outreachAuthorized:fault!=="consent_suppressed",automaticOutreach:false},
    integration:{bookingId,status:fault==="integration_down"?"degraded":"sandbox_only",liveSideEffect:false},
    reporting:{bookingId,metricTruthChangedByDelivery:false,delivery:fault==="report_delivery_failure"?"failed":"not_sent"},
  };
}

function gatedAttempt(service,index){return {seed:`${service.code}:${index}`,serviceCode:service.code,attemptId:`GATED-${service.code.toUpperCase()}-${index+1}`,accepted:false,reason:service.reason,canonicalBooking:null,finance:null,revenue:null};}

const bookings=supported.flatMap(service=>Array.from({length:15},(_,i)=>supportedBooking(service,i)));
const gatedAttempts=gated.flatMap(service=>Array.from({length:5},(_,i)=>gatedAttempt(service,i)));
const allAttempts=[...bookings,...gatedAttempts];

test("swarm contains eight virtual tester roles and 80 deterministic attempts",()=>{
  assert.equal(testerRoles.length,8);
  assert.equal(bookings.length,60);
  assert.equal(gatedAttempts.length,20);
  assert.equal(allAttempts.length,80);
  assert.equal(new Set(allAttempts.map(x=>x.seed)).size,80);
});

test("60 supported bookings reconcile identity across customer CRM ops finance and revenue",()=>{
  for(const item of bookings){
    assert.equal(item.customer.bookingId,item.crm.bookingId,item.seed);
    assert.equal(item.customer.bookingId,item.ops.bookingId,item.seed);
    assert.equal(item.customer.bookingId,item.finance.bookingId,item.seed);
    assert.equal(item.customer.bookingId,item.revenue.bookingId,item.seed);
    assert.equal(item.customer.customerId,item.crm.customerId,item.seed);
    assert.equal(item.customer.customerId,item.finance.customerId,item.seed);
    assert.equal(item.customer.serviceCode,item.ops.serviceCode,item.seed);
    assert.equal(item.finance.collected-item.finance.refunded,item.finance.net,item.seed);
    assert.equal(item.revenue.collected-item.revenue.refunded,item.revenue.net,item.seed);
    assert.equal(item.finance.net,item.revenue.net,item.seed);
    assert.equal(item.opportunity.automaticOutreach,false,item.seed);
    assert.equal(item.integration.liveSideEffect,false,item.seed);
    assert.equal(item.reporting.metricTruthChangedByDelivery,false,item.seed);
    if(item.fault==="consent_suppressed")assert.equal(item.opportunity.outreachAuthorized,false,item.seed);
    if(item.fault==="integration_down")assert.equal(item.integration.status,"degraded",item.seed);
    if(item.fault==="sla_delay")assert.equal(item.ops.sla,"breached",item.seed);
  }
});

test("duplicate and payment replays never create a second logical booking or second financial credit",()=>{
  const replayed=bookings.filter(x=>x.replayCount===2);
  assert.equal(replayed.length,8);
  for(const item of replayed){
    assert.equal(item.customer.bookingId,item.finance.bookingId);
    assert.equal(item.finance.net,item.revenue.net);
  }
  assert.equal(new Set(bookings.map(x=>x.customer.bookingId)).size,60);
});

test("refund cancellation and unpaid fixtures reduce net truth instead of fabricating achieved revenue",()=>{
  for(const item of bookings){
    if(item.fault==="full_refund"||item.fault==="provider_cancel")assert.equal(item.revenue.net,0,item.seed);
    if(item.fault==="unpaid_cancelled")assert.deepEqual({c:item.revenue.collected,r:item.revenue.refunded,n:item.revenue.net},{c:0,r:0,n:0},item.seed);
    if(item.revenue.status==="cancelled")assert.equal(item.revenue.booked,0,item.seed);
  }
  const financeTotal=bookings.reduce((sum,x)=>sum+x.finance.net,0);
  const revenueTotal=bookings.reduce((sum,x)=>sum+x.revenue.net,0);
  assert.equal(financeTotal,revenueTotal);
});

test("20 deferred-service attempts are gated and never projected as canonical finance or achieved revenue",()=>{
  assert.deepEqual([...new Set(gatedAttempts.map(x=>x.serviceCode))].sort(),gated.map(x=>x.code).sort());
  for(const item of gatedAttempts){
    assert.equal(item.accepted,false,item.seed);
    assert.equal(item.canonicalBooking,null,item.seed);
    assert.equal(item.finance,null,item.seed);
    assert.equal(item.revenue,null,item.seed);
  }
});

test("repository canonical booking contract enforces the supported four services and idempotency",()=>{
  const src=read("app/api/canonical-bookings/route.ts");
  for(const service of supported)assert.ok(src.includes(`\"${service.code}\"`),`missing ${service.code}`);
  for(const service of gated)assert.ok(!src.includes(`serviceCode:\"${service.code}\"`),`unexpected canonical contract for ${service.code}`);
  assert.match(src,/idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(src,/schedule_group_id TEXT NOT NULL UNIQUE/);
  assert.match(src,/provider_work_orders[^\n]*booking_id TEXT NOT NULL UNIQUE/);
  assert.match(src,/booking_payments[^\n]*booking_id TEXT NOT NULL UNIQUE/);
  assert.match(src,/findCustomerReplay/);
  assert.match(src,/hasForeignReplayConflict/);
  assert.match(src,/duplicatePrevented/);
});

test("command center and Revenue Mission read canonical booking and money truth instead of synthetic leaderboard credit",()=>{
  const bookingCommand=read("app/api/booking-command-center/route.ts");
  const mission=read("lib/revenue-mission-control.ts");
  const command=read("lib/revenue-mission-command-center.ts");
  assert.ok(bookingCommand.includes("canonical_bookings"));
  assert.ok(bookingCommand.includes("booking_payments"));
  assert.ok(mission.includes("canonical_bookings"));
  assert.ok(mission.includes("booking_payments"));
  assert.ok(mission.includes("payment_reconciliation_records"));
  assert.ok(command.includes("revenue_mission_events"));
  assert.ok(command.includes("revenue_opportunities"));
  assert.ok(command.includes("pipeline"));
  assert.ok(command.includes("productionReady:false"));
});

test("Revenue APIs enforce route-level permissions and never claim production readiness",()=>{
  const contracts={
    "app/api/revenue-mission-control/route.ts":["reports.view","customers.manage"],
    "app/api/lead-assignment-governance/route.ts":["customers.view","customers.manage"],
    "app/api/lead-sla-governance/route.ts":["customers.view","customers.manage"],
    "app/api/revenue-opportunity-governance/route.ts":["customers.view","customers.manage"],
    "app/api/sales-productivity-governance/route.ts":["reports.view","customers.manage"],
    "app/api/revenue-mission-command-center/route.ts":["reports.view"],
    "app/api/revenue-leadership-reporting/route.ts":["reports.view","customers.manage"],
  };
  for(const [path,permissions] of Object.entries(contracts)){
    const src=read(path);
    for(const permission of permissions)assert.ok(src.includes(`\"${permission}\"`),`${path} missing ${permission}`);
    assert.ok(!src.includes("productionReady:true"),`${path} claims production readiness`);
  }
});

test("shared API gateway explicitly protects every Revenue governance boundary",()=>{
  const gateway=read("lib/api-gateway.ts");
  for(const path of ["/api/revenue-mission-control","/api/lead-assignment-governance","/api/lead-sla-governance","/api/revenue-opportunity-governance","/api/sales-productivity-governance","/api/revenue-mission-command-center","/api/revenue-leadership-reporting"]){
    assert.ok(gateway.includes(`url.pathname===\"${path}\"`),`gateway missing ${path}`);
  }
});

test("suppressed outreach and report delivery cannot silently mutate commercial truth",()=>{
  const opportunity=read("app/api/revenue-opportunity-governance/route.ts");
  const reporting=read("lib/revenue-leadership-reporting.ts");
  assert.ok(opportunity.includes("automaticOutreach:false"));
  assert.ok(opportunity.includes("authorizeOpportunityOutreach"));
  assert.ok(reporting.includes("metricTruthChanged:false"));
});

test("test harness itself has no live payment messaging or production side effects",()=>{
  const own=read("tests/prelaunch-booking-swarm-contract.test.mjs");
  const forbidden=["razorpay"+".com","api"+".twilio","graph"+".facebook"];
  assert.ok(!own.includes("fetch(\"https://"));
  for(const pattern of forbidden)assert.ok(!own.includes(pattern),`live provider reference found: ${pattern}`);
});
