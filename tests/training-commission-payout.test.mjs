import test from"node:test";
import assert from"node:assert/strict";
import{DatabaseSync}from"node:sqlite";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";
installWorkersHooks("__TCM_DB__","__TCM_ENV__");

const DAY=86_400_000,BASE=Date.UTC(2026,8,1,10,0,0);
function d1(sqlite){const st=(sql,a)=>({bind:(...b)=>st(sql,b),first:async()=>sqlite.prepare(sql).get(...a)??null,run:async()=>{const r=sqlite.prepare(sql).run(...a);return{success:true,meta:{changes:Number(r.changes)}}},all:async()=>({results:sqlite.prepare(sql).all(...a)})});return{prepare:s=>st(s,[]),batch:async xs=>{const out=[];for(const x of xs)out.push(await x.run());return out},exec:async s=>{sqlite.exec(s);return{count:0,duration:0}}};}
async function world(){
 const sqlite=new DatabaseSync(":memory:"),db=d1(sqlite);globalThis.__TCM_DB__=db;
 const mod=await import("../lib/training-commission-payout.ts");
 await mod.ensureTrainingCommissionPayoutTables(db);
 sqlite.exec(`CREATE TABLE training_programmes(id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,total_sessions INTEGER);CREATE TABLE training_sessions(id TEXT PRIMARY KEY,programme_id TEXT,sequence_no INTEGER,status TEXT,completed_at INTEGER,updated_at INTEGER);CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,service_code TEXT,total_amount REAL,status TEXT,updated_at INTEGER);CREATE TABLE provider_work_orders(id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,provider_model TEXT,status TEXT);`);
 sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK','dog_training',10000,'in_progress',?)").run(BASE);
 sqlite.prepare("INSERT INTO provider_work_orders VALUES ('WO','BK','PRV','commission','assigned')").run();
 sqlite.prepare("INSERT INTO training_programmes VALUES ('PG','BK','PRV',10)").run();
 await db.prepare("INSERT INTO provider_compensation_profiles(provider_id,engagement_model,default_commission_mode,default_commission_value,status,reason,updated_by,created_at,updated_at) VALUES ('PRV','commission','percent',70,'active','test fixture','qa',?,?)").bind(BASE,BASE).run();
 for(let i=1;i<=10;i++)sqlite.prepare("INSERT INTO training_sessions VALUES (?,?,?,?,?,?)").run(`S${i}`,'PG',i,'locked',null,BASE);
 return{sqlite,db,mod};
}
function complete(sqlite,n,at){for(let i=1;i<=n;i++)sqlite.prepare("UPDATE training_sessions SET status='completed',completed_at=? WHERE id=?").run(at+(i-1)*1000,`S${i}`);}

test("Training commission has no payout before 50% of package sessions",async()=>{const w=await world();complete(w.sqlite,4,BASE);await w.mod.syncTrainingCommissionPayoutMilestones(w.db,BASE+10*DAY);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_commission_payout_milestones").get().n,0);});

test("50% sessions unlock only 50% commission after five days",async()=>{const w=await world();complete(w.sqlite,5,BASE);await w.mod.syncTrainingCommissionPayoutMilestones(w.db,BASE+2*DAY);let row=w.sqlite.prepare("SELECT * FROM training_commission_payout_milestones WHERE milestone_code='first_50_percent'").get();assert.equal(Number(row.payout_amount),3500);assert.equal(row.status,"waiting_5_days");await assert.rejects(()=>w.mod.approveTrainingCommissionMilestone(w.db,{bookingId:"BK",milestoneCode:"first_50_percent",idempotencyKey:"M1",actorId:"finance",reason:"approved fixture",asOf:BASE+2*DAY}),e=>e instanceof Response&&e.status===409);await w.mod.syncTrainingCommissionPayoutMilestones(w.db,BASE+6*DAY);row=w.sqlite.prepare("SELECT * FROM training_commission_payout_milestones WHERE milestone_code='first_50_percent'").get();assert.equal(row.status,"ready_for_finance_approval");const approved=await w.mod.approveTrainingCommissionMilestone(w.db,{bookingId:"BK",milestoneCode:"first_50_percent",idempotencyKey:"M1",actorId:"finance",reason:"approved fixture",asOf:BASE+6*DAY});assert.equal(approved.amount,3500);assert.equal(approved.status,"instruction_ready_sandbox");});

test("final 50% is separate and waits five days after package completion",async()=>{const w=await world();complete(w.sqlite,5,BASE);await w.mod.syncTrainingCommissionPayoutMilestones(w.db,BASE+6*DAY);await w.mod.approveTrainingCommissionMilestone(w.db,{bookingId:"BK",milestoneCode:"first_50_percent",idempotencyKey:"M1",actorId:"finance",reason:"approved fixture",asOf:BASE+6*DAY});complete(w.sqlite,10,BASE+10*DAY);await w.mod.syncTrainingCommissionPayoutMilestones(w.db,BASE+12*DAY);let rows=w.sqlite.prepare("SELECT milestone_code,payout_amount,status FROM training_commission_payout_milestones ORDER BY milestone_code").all();assert.equal(rows.length,2);assert.equal(rows.find(r=>r.milestone_code==='first_50_percent').status,"instruction_ready_sandbox");assert.equal(Number(rows.find(r=>r.milestone_code==='final_50_percent').payout_amount),3500);assert.equal(rows.find(r=>r.milestone_code==='final_50_percent').status,"waiting_5_days");await w.mod.syncTrainingCommissionPayoutMilestones(w.db,BASE+16*DAY);assert.equal(w.sqlite.prepare("SELECT status FROM training_commission_payout_milestones WHERE milestone_code='final_50_percent'").get().status,"ready_for_finance_approval");});

test("commission percentage is configured, not invented",async()=>{const w=await world();w.sqlite.prepare("UPDATE provider_compensation_profiles SET default_commission_value=60 WHERE provider_id='PRV'").run();complete(w.sqlite,5,BASE);await w.mod.syncTrainingCommissionPayoutMilestones(w.db,BASE+6*DAY);assert.equal(Number(w.sqlite.prepare("SELECT package_commission_amount FROM training_commission_payout_milestones").get().package_commission_amount),6000);assert.equal(Number(w.sqlite.prepare("SELECT payout_amount FROM training_commission_payout_milestones").get().payout_amount),3000);});
