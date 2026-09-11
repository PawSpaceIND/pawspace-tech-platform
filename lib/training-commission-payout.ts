import{ensureProviderCommissionTables}from"./provider-commission-governance";

type Row=Record<string,unknown>;
const FIVE_DAYS=5*24*60*60*1000;
const money=(value:number)=>Math.round(value*100)/100;

function commissionAmount(orderAmount:number,mode:string,value:number){
 if(!Number.isFinite(orderAmount)||orderAmount<0)throw new Error("Training order amount is invalid");
 if(!Number.isFinite(value)||value<0)throw new Error("Training commission value is invalid");
 if(mode==="percent"){
  if(value>100)throw new Error("Training commission percent cannot exceed 100");
  return money(orderAmount*value/100);
 }
 if(mode==="fixed")return money(Math.min(orderAmount,value));
 throw new Error("Training commission mode is not configured");
}

export async function ensureTrainingCommissionPayoutTables(db:D1Database){
 await ensureProviderCommissionTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS training_commission_payout_milestones (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,programme_id TEXT NOT NULL,provider_id TEXT NOT NULL,milestone_code TEXT NOT NULL,threshold_sessions INTEGER NOT NULL,total_sessions INTEGER NOT NULL,commission_mode TEXT NOT NULL,commission_value REAL NOT NULL,package_commission_amount REAL NOT NULL,payout_amount REAL NOT NULL,reached_at INTEGER NOT NULL,due_at INTEGER NOT NULL,status TEXT NOT NULL,approval_idempotency_key TEXT UNIQUE,approved_by TEXT,approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(booking_id,milestone_code))"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_training_commission_due ON training_commission_payout_milestones(status,due_at)"),
 ]);
}

export async function syncTrainingCommissionPayoutMilestones(db:D1Database,asOf=Date.now()){
 await ensureTrainingCommissionPayoutTables(db);
 let programmes:Row[]=[];
 try{
  const result=await db.prepare("SELECT p.id programme_id,p.booking_id,w.provider_id,p.total_sessions,b.total_amount,c.engagement_model,c.default_commission_mode,c.default_commission_value FROM training_programmes p JOIN canonical_bookings b ON b.id=p.booking_id JOIN provider_work_orders w ON w.booking_id=p.booking_id LEFT JOIN provider_compensation_profiles c ON c.provider_id=w.provider_id AND c.status='active' WHERE b.service_code IN ('dog_training','training') AND w.provider_model='commission'").all<Row>();
  programmes=result.results;
 }catch{return{synced:0,skippedConfiguration:0};}
 let synced=0,skippedConfiguration=0;
 for(const p of programmes){
  const mode=String(p.default_commission_mode||""),value=Number(p.default_commission_value);
  if(String(p.engagement_model)!=="commission"||!["percent","fixed"].includes(mode)||!Number.isFinite(value)){
   skippedConfiguration++;continue;
  }
  const totalSessions=Number(p.total_sessions||0);
  if(!Number.isInteger(totalSessions)||totalSessions<=0)continue;
  /*
   * Ordered by WHEN each session was completed, not by its number in the plan. A milestone is
   * reached at the Nth completion, and `reachedAt` below indexes straight into this list to start
   * the five-day hold from it. Ordering by sequence_no made those two different things whenever a
   * programme ran out of order - a rescheduled session 3 finished after 4 and 5 - and it picked an
   * EARLIER completion, so the hold was already expired on the day the milestone was actually
   * reached and the commission became approvable immediately. The five-day window is the whole
   * point of the rule: it is the time in which a customer complaint can still stop the money.
   * [D31-T4]
   */
  const completed=await db.prepare("SELECT sequence_no,COALESCE(completed_at,updated_at) completed_at FROM training_sessions WHERE programme_id=? AND status='completed' ORDER BY COALESCE(completed_at,updated_at),sequence_no").bind(String(p.programme_id)).all<Row>();
  const count=completed.results.length,halfThreshold=Math.ceil(totalSessions/2);
  const packageCommission=commissionAmount(Number(p.total_amount||0),mode,value);
  const firstAmount=money(packageCommission/2),finalAmount=money(packageCommission-firstAmount);
  const milestones=[{code:"first_50_percent",threshold:halfThreshold,amount:firstAmount},{code:"final_50_percent",threshold:totalSessions,amount:finalAmount}];
  for(const milestone of milestones){
   if(count<milestone.threshold)continue;
   const reachedAt=Number(completed.results[milestone.threshold-1]?.completed_at||0);
   if(!Number.isFinite(reachedAt)||reachedAt<=0)continue;
   const dueAt=reachedAt+FIVE_DAYS,status=asOf>=dueAt?"ready_for_finance_approval":"waiting_5_days";
   const id=`TCM-${String(p.booking_id)}-${milestone.code}`;
   await db.prepare("INSERT INTO training_commission_payout_milestones (id,booking_id,programme_id,provider_id,milestone_code,threshold_sessions,total_sessions,commission_mode,commission_value,package_commission_amount,payout_amount,reached_at,due_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(booking_id,milestone_code) DO UPDATE SET status=CASE WHEN training_commission_payout_milestones.status='instruction_ready_sandbox' THEN training_commission_payout_milestones.status ELSE excluded.status END,updated_at=excluded.updated_at").bind(id,String(p.booking_id),String(p.programme_id),String(p.provider_id),milestone.code,milestone.threshold,totalSessions,mode,value,packageCommission,milestone.amount,reachedAt,dueAt,status,asOf,asOf).run();
   synced++;
  }
 }
 return{synced,skippedConfiguration};
}

export async function approveTrainingCommissionMilestone(db:D1Database,input:{bookingId:string;milestoneCode:"first_50_percent"|"final_50_percent";idempotencyKey:string;actorId:string;reason:string;asOf?:number}){
 const now=input.asOf??Date.now();
 await syncTrainingCommissionPayoutMilestones(db,now);
 if(!input.bookingId||!input.idempotencyKey.trim()||input.reason.trim().length<8)throw new Response("Booking, idempotency key and clear reason are required",{status:400});
 const prior=await db.prepare("SELECT * FROM training_commission_payout_milestones WHERE approval_idempotency_key=?").bind(input.idempotencyKey).first<Row>();
 if(prior)return{...prior,duplicatePrevented:true,livePayout:false};
 const row=await db.prepare("SELECT * FROM training_commission_payout_milestones WHERE booking_id=? AND milestone_code=?").bind(input.bookingId,input.milestoneCode).first<Row>();
 if(!row)throw new Response("Training commission milestone is not reached",{status:404});
 if(now<Number(row.due_at))throw new Response("Training commission payout is not eligible until five days after the milestone is reached",{status:409});
 if(String(row.status)!=="ready_for_finance_approval")throw new Response("Training commission milestone is not ready for approval",{status:409});
 const changed=await db.prepare("UPDATE training_commission_payout_milestones SET status='instruction_ready_sandbox',approval_idempotency_key=?,approved_by=?,approved_at=?,updated_at=? WHERE booking_id=? AND milestone_code=? AND status='ready_for_finance_approval' AND due_at<=?").bind(input.idempotencyKey,input.actorId,now,now,input.bookingId,input.milestoneCode,now).run();
 if(Number(changed.meta?.changes||0)!==1)throw new Response("Training commission milestone approval lost its eligibility race",{status:409});
 return{bookingId:input.bookingId,milestoneCode:input.milestoneCode,amount:Number(row.payout_amount),status:"instruction_ready_sandbox",dueAt:Number(row.due_at),livePayout:false,duplicatePrevented:false};
}

export async function listTrainingCommissionMilestones(db:D1Database){
 await syncTrainingCommissionPayoutMilestones(db);
 const result=await db.prepare("SELECT * FROM training_commission_payout_milestones ORDER BY due_at DESC,booking_id,milestone_code").all<Row>();
 return result.results;
}
