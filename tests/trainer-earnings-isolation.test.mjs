import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {freshWorld,seedBooking,TRAINER,OTHER_TRAINER,routeCall,sessionCookie} from "./helpers/training-lifecycle-harness.mjs";
const {materializeTrainingBooking}=await import("../lib/training-programme.ts");
const {ensureTrainingFinanceTables,listTrainerEarnings,refreshTrainingFinanceReadModel}=await import("../lib/training-finance.ts");
const route=await import("../app/api/training-provider-earnings/route.ts");
const React=await import("react");const {renderToStaticMarkup}=await import("react-dom/server");
const {default:EarningsLoadState}=await import("../app/trainer/earnings-load-state.tsx");

async function seeded(){
 const world=freshWorld();
 for(const [id,provider] of [["OWN",TRAINER],["OTHER",OTHER_TRAINER]]){
  seedBooking(world,{id,group:id+"-G",provider,sessions:2,total:1000,dueNow:500});await materializeTrainingBooking(world.db,{bookingId:id,actorId:"qa"});
 }
 await ensureTrainingFinanceTables(world.db);
 // A foreign programme has no published city tax policy; the finance guard must still reject it.
 world.sqlite.prepare("UPDATE training_programmes SET city_id='unconfigured-city' WHERE booking_id='OTHER'").run();
 return world;
}
test("provider earnings loads despite unrelated finance blockers without issuing invoices or payouts",async()=>{
 const world=await seeded();
 const cookie=await sessionCookie(world.db,"provider",TRAINER);
 const response=await routeCall(route.GET,"GET","/api/training-provider-earnings?providerId="+TRAINER,{cookie});
 assert.equal(response.status,200,JSON.stringify(response.body));assert.deepEqual(response.body.data.earnings,[]);
 for(const table of ["training_finance_invoices","training_payout_statements","training_session_earnings"])assert.equal(world.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 await assert.rejects(refreshTrainingFinanceReadModel(world.db),error=>error instanceof Response&&error.status===409,"finance approval retains tax guard");
 const forbidden=await routeCall(route.GET,"GET","/api/training-provider-earnings?providerId="+OTHER_TRAINER,{cookie});assert.equal(forbidden.status,403);
});
test("owned earnings retain compensation and payment-coverage holds without calculating foreign earnings",async()=>{
 const world=await seeded(),now=Date.now();
 world.sqlite.prepare("UPDATE training_sessions SET status='completed',completed_at=?").run(now);
 world.sqlite.prepare("INSERT INTO training_compensation_rules(id,city_id,rate_value,effective_from,updated_by,reason,updated_at) VALUES ('QA-RATE','blr',125.50,'2020-01-01','qa','Isolated test rate',?)").run(now);
 const data=await listTrainerEarnings(world.db,TRAINER);
 assert.equal(data.earnings.length,2);assert.deepEqual(data.earnings.map(e=>e.status).sort(),["earned","held_payment"]);assert.ok(data.earnings.every(e=>e.gross_earning===125.50));
 assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_session_earnings WHERE provider_id=?").get(OTHER_TRAINER).n,0);
 assert.deepEqual(data.payouts,[]);assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM training_finance_invoices").get().n,0);
});
test("replacement trainer payment coverage counts earlier sessions delivered by another provider",async()=>{
 const world=await seeded(),now=Date.now();world.sqlite.prepare("UPDATE training_sessions SET status='completed',completed_at=? WHERE booking_id='OWN'").run(now);
 world.sqlite.prepare("UPDATE training_sessions SET provider_id=? WHERE booking_id='OWN' AND sequence_no=1").run(OTHER_TRAINER);
 world.sqlite.prepare("INSERT INTO training_compensation_rules(id,city_id,rate_value,effective_from,updated_by,reason,updated_at) VALUES ('QA-RATE','blr',125,'2020-01-01','qa','Isolated test rate',?)").run(now);
 const data=await listTrainerEarnings(world.db,TRAINER);assert.equal(data.earnings.length,1);assert.equal(data.earnings[0].status,"held_payment");
});
test("earnings error and loading states never masquerade as zero earnings and offer recovery",()=>{
 const render=props=>renderToStaticMarkup(React.createElement(EarningsLoadState,{onRetry:()=>{},...props},React.createElement("div",null,"₹0 · No earnings ledger yet")));
 const error=render({loading:false,error:"Unable to load Training earnings",loaded:false});assert.match(error,/Retry earnings/);assert.doesNotMatch(error,/₹0|No earnings ledger yet/);
 const loading=render({loading:true,error:"",loaded:false});assert.match(loading,/Loading Training earnings/);assert.doesNotMatch(loading,/₹0/);
 assert.match(render({loading:false,error:"",loaded:true}),/₹0/);
});

// ---------------------------------------------------------------------------------------------------
// LP-N17. Every completed Training session on staging was held at "pending rate configuration - No
// published trainer compensation rule matches this completed session", so trainer earnings, payout
// statements and the Finance training views could not be exercised at all. The cases above seed a rule
// by hand, which proves the calculation but not that a tester on staging ever gets one.
//
// Owner decision 2026-09-22: seed a placeholder. These cases load the REAL staging seed and drive the
// real read model through it, so a seed that stops publishing the rule fails here.
// ---------------------------------------------------------------------------------------------------

test("LP-N17: the staging seed publishes a trainer rate, so a completed session stops being held", async () => {
  const world = await seeded(), now = Date.now();
  world.sqlite.prepare("UPDATE training_programmes SET city_id='blr' WHERE booking_id='OTHER'").run();
  world.sqlite.prepare("UPDATE training_sessions SET status='completed',completed_at=?").run(now);

  const before = await listTrainerEarnings(world.db, TRAINER);
  assert.ok(before.earnings.every(e => e.status === "pending_rate_configuration"),
    "precondition: with no published rule every completed session is held");
  assert.match(String(before.earnings[0].hold_reason), /No published trainer compensation rule/);

  // The real file the staging deploy loads - not a hand-written rule.
  world.sqlite.exec(fs.readFileSync(new URL("../scripts/uat-staging-provider-capacity.sql", import.meta.url), "utf8"));

  const after = await listTrainerEarnings(world.db, TRAINER);
  assert.equal(after.earnings.length, 2);
  assert.ok(after.earnings.every(e => e.status !== "pending_rate_configuration"),
    "the seeded rule must resolve every completed session");
  assert.ok(after.earnings.every(e => Number(e.gross_earning) > 0), "a resolved session must carry a real figure");
  assert.ok(after.earnings.every(e => e.rule_id === "UAT-TRAINER-RATE-BLR"), "it must be the seeded rule that matched");
});

test("LP-N17: the seeded rate is unmistakably sandbox data, not a compensation policy", () => {
  const seed = fs.readFileSync(new URL("../scripts/uat-staging-provider-capacity.sql", import.meta.url), "utf8");
  const row = seed.split("\n").find(line => line.includes("UAT-TRAINER-RATE-BLR"));
  assert.ok(row, "the staging seed must publish a trainer rate");
  assert.match(row, /UAT-ONLY-NOT-PRODUCTION/, "the row must say plainly that it is not a policy");
  assert.match(row, /'per_completed_session'/, "the placeholder must use the rate type the calculation expects");
  // provider_id and package_code stay NULL so every seeded trainer and package is covered, and a real
  // Finance-published rule outranks this one rather than colliding with it.
  assert.match(row, /'blr',NULL,NULL,/, "the placeholder must not be pinned to one trainer or package");
});
