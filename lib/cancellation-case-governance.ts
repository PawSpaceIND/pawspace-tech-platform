/**
 * What happens when a customer asks to cancel a booking that has already started. [PTJA-W1-F24]
 *
 * THE APPROVED RULE. Once a booking reaches EN_ROUTE, ARRIVED, IN_SERVICE or COMPLETED, a customer
 * cancellation request must NOT directly cancel the booking. It opens a reviewable case and preserves
 * the operational state, because a job under way has real consequences for the provider standing in
 * front of the customer and for the money already taken.
 *
 *   Cancellation requested -> Case opened -> Booking remains active -> Operations decision
 *   -> Finance decision if applicable -> Customer and provider notified -> Case closed
 *
 * PER STATUS:
 *   EN_ROUTE / ARRIVED  the booking stays active; Operations decides proceed, stop or return.
 *   IN_SERVICE          the booking stays in service; the customer cannot cancel it automatically.
 *   COMPLETED           cancellation is unavailable; the request is a service-quality/refund dispute.
 *
 * A NOTE ON NAMES. The approved rule says EN_ROUTE; this platform's lifecycle calls that same state
 * `on_the_way` (app/api/grooming-lifecycle/route.ts). Both names are configured, because a policy that
 * only knows the business's word for a state does not protect the state. Measured while implementing
 * this: with only `en_route` configured, a customer cancelling while the groomer was ALREADY DRIVING to
 * the house - status `on_the_way` - fell through to the notice ladder and was auto-refunded the full
 * Rs 2,000. That is now closed and the configuration surface refuses to save a list missing either name.
 *
 * WHAT OPENING A CASE DOES NOT DO. It does not promise a refund, it does not reverse a payment, it does
 * not remove a provider payout, and it does not touch attendance, OTP, delivery evidence or service
 * records. Those change only on an authorised decision, recorded with an actor, a reason, a timestamp,
 * evidence and the customer/provider communication. Provider payout stays a calculation from arrival,
 * work performed, travel and fault attribution - not something a case erases by existing.
 *
 * WHO MAY DECIDE. Only Operations/Manager staff may operationally stop a job, and a stop uses a DISTINCT
 * terminal status (`stopped_after_start`) rather than ordinary `cancelled`, so a job that ran and was
 * halted is never confused with one that never happened. Only Finance/Manager roles may approve a full
 * or partial refund. Both permission sets are policy, configured per service and city like everything
 * else in Control Center.
 */
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;
type Row=Record<string,unknown>;

export const CANCELLATION_CASE_DOMAIN="cancellation_case_policy";

/** The two shapes a post-start request can take. A completed job cannot be cancelled, only disputed. */
export type CaseType="cancellation_review"|"service_dispute";
export type OpsDecision="proceed"|"stop"|"return";
export type FinanceDecision="refund_full"|"refund_partial"|"no_refund";

export type CancellationCasePolicyConfig={
  reasonCategories:string[];
  defaultCustomerReasonCategory:string;
  /** Statuses at which a customer request opens a case instead of cancelling. */
  caseOnlyStatuses:string[];
  /** Statuses where cancellation is unavailable entirely and the case is a dispute. */
  disputeOnlyStatuses:string[];
  /** Which Operations decisions are available at each status. */
  opsDecisionsByStatus:Record<string,OpsDecision[]>;
  stoppedTerminalStatus:string;
  opsStopPermissions:string[];
  refundApprovalPermissions:string[];
  requireEvidenceOnOpsDecision:boolean;
  requireCustomerCommunication:boolean;
};

export const APPROVED_CANCELLATION_CASE_POLICY:CancellationCasePolicyConfig={
  reasonCategories:[
    "customer_changed_mind","pet_unavailable_or_unsafe","provider_misconduct","service_quality_failure",
    "medical_or_safety_incident","access_denied","wrong_service_or_booking_details",
    "duplicate_or_incorrect_booking","pawspace_operational_failure",
  ],
  // A customer who asks to cancel without saying why has changed their mind, by default. Operations can
  // recategorise on the decision, and does so on the record.
  defaultCustomerReasonCategory:"customer_changed_mind",
  caseOnlyStatuses:["on_the_way","en_route","arrived","in_service"],
  disputeOnlyStatuses:["completed"],
  opsDecisionsByStatus:{
    on_the_way:["proceed","stop","return"],
    en_route:["proceed","stop","return"],
    arrived:["proceed","stop","return"],
    in_service:["proceed","stop"],
    completed:[],
  },
  stoppedTerminalStatus:"stopped_after_start",
  opsStopPermissions:["bookings.manage"],
  refundApprovalPermissions:["finance.manage","bookings.manage"],
  requireEvidenceOnOpsDecision:true,
  requireCustomerCommunication:true,
};

registerServicePolicyDomain<CancellationCasePolicyConfig&Record<string,unknown>>({
  domain:CANCELLATION_CASE_DOMAIN,
  label:"Post-start cancellation and dispute cases",
  managePermission:"settings.manage",
  defaults:APPROVED_CANCELLATION_CASE_POLICY as CancellationCasePolicyConfig&Record<string,unknown>,
  problem(config){
    const categories=config.reasonCategories;
    if(!Array.isArray(categories)||!categories.length)return "At least one reason category is required";
    if(!categories.map(String).includes(String(config.defaultCustomerReasonCategory)))return "The default customer reason category must be one of the configured categories";
    const caseOnly=config.caseOnlyStatuses,disputeOnly=config.disputeOnlyStatuses;
    if(!Array.isArray(caseOnly)||!Array.isArray(disputeOnly))return "caseOnlyStatuses and disputeOnlyStatuses must be lists";
    // Both names for the same state. Dropping either reopens the measured defect where a customer
    // cancelling while the provider was already driving was auto-refunded in full.
    for(const required of ["on_the_way","en_route","arrived","in_service"]){
      if(!caseOnly.map(String).includes(required))return `caseOnlyStatuses must include ${required}`;
    }
    if(!disputeOnly.map(String).includes("completed"))return "disputeOnlyStatuses must include completed";
    const stopped=String(config.stoppedTerminalStatus||"");
    if(!stopped)return "A terminal status for a stopped job is required";
    // A job that ran and was halted must never be recorded as one that never happened - payout,
    // attendance and reporting all read that distinction.
    if(stopped==="cancelled")return "A job stopped after it started must use a distinct terminal status, not ordinary cancelled";
    if(!Array.isArray(config.opsStopPermissions)||!config.opsStopPermissions.length)return "At least one Operations permission may stop a job";
    if(!Array.isArray(config.refundApprovalPermissions)||!config.refundApprovalPermissions.length)return "At least one permission may approve a refund";
    const byStatus=config.opsDecisionsByStatus as Record<string,string[]>|undefined;
    if(!byStatus||typeof byStatus!=="object")return "opsDecisionsByStatus is required";
    for(const status of caseOnly.map(String)){
      const decisions=byStatus[status];
      if(!Array.isArray(decisions)||!decisions.length)return `opsDecisionsByStatus must offer at least one decision for ${status}`;
      for(const decision of decisions)if(!["proceed","stop","return"].includes(String(decision)))return `Unknown Operations decision ${decision} for ${status}`;
    }
    return null;
  },
});

export async function resolveCancellationCasePolicy(db:Db,scope:{serviceCode?:string|null;cityId?:string|null}={},at=new Date()){
  return resolveServicePolicy<CancellationCasePolicyConfig&Record<string,unknown>>(db,CANCELLATION_CASE_DOMAIN,scope,at);
}

const casesEnsured=new WeakSet<Db>();
export async function ensureCancellationCaseTables(db:Db){
  if(casesEnsured.has(db))return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS booking_cancellation_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,case_type TEXT NOT NULL,booking_status_at_request TEXT NOT NULL,reason_category TEXT NOT NULL,reason_text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',requested_by TEXT NOT NULL,requested_at INTEGER NOT NULL,ops_decision TEXT,ops_decision_by TEXT,ops_decision_at INTEGER,ops_decision_reason TEXT,ops_evidence_json TEXT,finance_decision TEXT,finance_decision_by TEXT,finance_decision_at INTEGER,finance_decision_reason TEXT,refund_amount_approved REAL,closed_at INTEGER,closed_by TEXT,closed_reason TEXT,policy_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    // Exactly one OPEN case per booking. A duplicate request reuses it rather than opening a second, and
    // the database - not the handler - is what guarantees that under concurrency.
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_cancellation_case_one_open ON booking_cancellation_cases(booking_id) WHERE status!='closed'"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_cancellation_case_events (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',evidence_json TEXT NOT NULL DEFAULT '{}',communication_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_cancellation_case_events ON booking_cancellation_case_events(case_id,occurred_at)"),
  ]);
  casesEnsured.add(db);
}

async function caseEvent(db:Db,input:{caseId:string;bookingId:string;eventType:string;actorId:string;reason?:string;evidence?:unknown;communication?:unknown;now:number}){
  await db.prepare("INSERT INTO booking_cancellation_case_events (id,case_id,booking_id,event_type,actor_id,reason,evidence_json,communication_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),input.caseId,input.bookingId,input.eventType,input.actorId,input.reason??"",JSON.stringify(input.evidence??{}),JSON.stringify(input.communication??{}),input.now).run();
}

export type OpenCaseInput={
  bookingId:string;customerId:string;serviceCode:string;cityId:string;bookingStatus:string;
  requestedBy:string;reasonCategory?:string|null;reasonText:string;refundEvaluation?:unknown;now?:number;
};

/**
 * Opens the reviewable case, or returns the open one that already exists. Never touches the booking,
 * the payment, the payout or any service record.
 */
export async function openCancellationCase(db:Db,input:OpenCaseInput){
  await ensureCancellationCaseTables(db);
  const policy=await resolveCancellationCasePolicy(db,{serviceCode:input.serviceCode,cityId:input.cityId});
  const config=policy.config;
  const status=String(input.bookingStatus||"").trim().toLowerCase();
  const now=input.now??Date.now();

  const existing=await db.prepare("SELECT * FROM booking_cancellation_cases WHERE booking_id=? AND status!='closed'").bind(input.bookingId).first<Row>();
  if(existing){
    // A customer tapping cancel twice is one request, not two. The repeat is recorded on the existing
    // case so Operations can see the customer asked again, but no second case is opened.
    await caseEvent(db,{caseId:String(existing.id),bookingId:input.bookingId,eventType:"duplicate_request_recorded",actorId:input.requestedBy,reason:input.reasonText,now});
    return{case:rowToCase(existing),reused:true,policy};
  }

  const category=String(input.reasonCategory||"").trim()||config.defaultCustomerReasonCategory;
  if(!config.reasonCategories.map(String).includes(category)){
    throw Response.json({error:"Unknown cancellation reason category",code:"unknown_reason_category",allowed:config.reasonCategories},{status:400});
  }
  const caseType:CaseType=config.disputeOnlyStatuses.map(String).includes(status)?"service_dispute":"cancellation_review";
  const id=`CASE-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
  await db.prepare("INSERT INTO booking_cancellation_cases (id,booking_id,customer_id,service_code,city_id,case_type,booking_status_at_request,reason_category,reason_text,status,requested_by,requested_at,policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?)")
    .bind(id,input.bookingId,input.customerId,input.serviceCode,input.cityId,caseType,status,category,input.reasonText,input.requestedBy,now,JSON.stringify({policyVersion:policy.policyVersion,refundEvaluation:input.refundEvaluation??null}),now,now).run();
  await caseEvent(db,{caseId:id,bookingId:input.bookingId,eventType:"case_opened",actorId:input.requestedBy,reason:input.reasonText,evidence:{bookingStatusAtRequest:status,reasonCategory:category},now});
  const created=await db.prepare("SELECT * FROM booking_cancellation_cases WHERE id=?").bind(id).first<Row>();
  return{case:rowToCase(created as Row),reused:false,policy};
}

export type CancellationCase=ReturnType<typeof rowToCase>;
function rowToCase(row:Row){return{
  id:String(row.id),bookingId:String(row.booking_id),customerId:String(row.customer_id),serviceCode:String(row.service_code),cityId:String(row.city_id),
  caseType:String(row.case_type) as CaseType,bookingStatusAtRequest:String(row.booking_status_at_request),
  reasonCategory:String(row.reason_category),reasonText:String(row.reason_text),status:String(row.status),
  requestedBy:String(row.requested_by),requestedAt:Number(row.requested_at),
  opsDecision:row.ops_decision?String(row.ops_decision):null,opsDecisionBy:row.ops_decision_by?String(row.ops_decision_by):null,opsDecisionAt:row.ops_decision_at?Number(row.ops_decision_at):null,
  financeDecision:row.finance_decision?String(row.finance_decision):null,financeDecisionBy:row.finance_decision_by?String(row.finance_decision_by):null,
  refundAmountApproved:row.refund_amount_approved===null||row.refund_amount_approved===undefined?null:Number(row.refund_amount_approved),
  closedAt:row.closed_at?Number(row.closed_at):null,
};}

export async function getCancellationCase(db:Db,caseId:string){
  await ensureCancellationCaseTables(db);
  const row=await db.prepare("SELECT * FROM booking_cancellation_cases WHERE id=?").bind(caseId).first<Row>();
  return row?rowToCase(row):null;
}

export type OpsDecisionInput={caseId:string;decision:OpsDecision;actorId:string;actorPermissions:readonly string[];reason:string;evidence?:unknown;communication?:unknown;now?:number};

/**
 * The Operations decision. Only a stop changes the booking, and it uses the distinct terminal status so
 * a job that ran and was halted is never recorded as one that never happened. Nothing here touches the
 * payment, the payout or any service record - a refund is a separate, separately authorised decision.
 */
export async function recordOpsDecision(db:Db,input:OpsDecisionInput){
  await ensureCancellationCaseTables(db);
  const row=await db.prepare("SELECT * FROM booking_cancellation_cases WHERE id=?").bind(input.caseId).first<Row>();
  if(!row)throw Response.json({error:"Cancellation case not found"},{status:404});
  if(String(row.status)==="closed")throw Response.json({error:"This case is already closed"},{status:409});
  const policy=await resolveCancellationCasePolicy(db,{serviceCode:String(row.service_code),cityId:String(row.city_id)});
  const config=policy.config;
  const status=String(row.booking_status_at_request);
  const allowed=config.opsDecisionsByStatus[status]??[];
  if(!allowed.includes(input.decision))throw Response.json({error:`Operations cannot ${input.decision} a booking that was ${status}`,code:"ops_decision_not_available",allowed},{status:409});
  const holds=(needed:readonly string[])=>input.actorPermissions.includes("*")||needed.some(permission=>input.actorPermissions.includes(permission));
  // Only Operations/Manager staff may operationally stop a job. Named from policy, not assumed of the
  // caller - the gateway is the first gate and this is the second.
  if(input.decision!=="proceed"&&!holds(config.opsStopPermissions))throw Response.json({error:"Stopping a job in progress requires an authorised Operations role",code:"ops_stop_not_permitted",required:config.opsStopPermissions},{status:403});
  if(!input.reason||input.reason.trim().length<5)throw Response.json({error:"A clear decision reason is required"},{status:400});
  if(config.requireEvidenceOnOpsDecision&&input.decision!=="proceed"&&!input.evidence)throw Response.json({error:"Stopping or returning a job requires recorded evidence"},{status:400});
  if(config.requireCustomerCommunication&&!input.communication)throw Response.json({error:"The customer and provider communication must be recorded with the decision"},{status:400});

  const now=input.now??Date.now();
  const statements=[
    db.prepare("UPDATE booking_cancellation_cases SET ops_decision=?,ops_decision_by=?,ops_decision_at=?,ops_decision_reason=?,ops_evidence_json=?,status='awaiting_finance',updated_at=? WHERE id=?")
      .bind(input.decision,input.actorId,now,input.reason.trim(),JSON.stringify(input.evidence??{}),now,input.caseId),
  ];
  if(input.decision==="stop"||input.decision==="return"){
    statements.push(db.prepare("UPDATE canonical_bookings SET status=?,updated_at=? WHERE id=?").bind(config.stoppedTerminalStatus,now,String(row.booking_id)));
    statements.push(db.prepare("UPDATE provider_work_orders SET status=?,updated_at=? WHERE booking_id=?").bind(config.stoppedTerminalStatus,now,String(row.booking_id)));
  }
  await db.batch(statements);
  await caseEvent(db,{caseId:input.caseId,bookingId:String(row.booking_id),eventType:`ops_${input.decision}`,actorId:input.actorId,reason:input.reason.trim(),evidence:input.evidence,communication:input.communication,now});
  return{case:(await getCancellationCase(db,input.caseId))!,stoppedStatus:input.decision==="proceed"?null:config.stoppedTerminalStatus};
}

export type FinanceDecisionInput={caseId:string;decision:FinanceDecision;refundAmount?:number;actorId:string;actorPermissions:readonly string[];reason:string;communication?:unknown;now?:number};

/** The refund decision. Separate authorisation, separate record, and never implied by the Ops decision. */
export async function recordFinanceDecision(db:Db,input:FinanceDecisionInput){
  await ensureCancellationCaseTables(db);
  const row=await db.prepare("SELECT * FROM booking_cancellation_cases WHERE id=?").bind(input.caseId).first<Row>();
  if(!row)throw Response.json({error:"Cancellation case not found"},{status:404});
  if(String(row.status)==="closed")throw Response.json({error:"This case is already closed"},{status:409});
  const policy=await resolveCancellationCasePolicy(db,{serviceCode:String(row.service_code),cityId:String(row.city_id)});
  const config=policy.config;
  const holds=input.actorPermissions.includes("*")||config.refundApprovalPermissions.some(permission=>input.actorPermissions.includes(permission));
  if(!holds)throw Response.json({error:"Approving a refund requires an authorised Finance or Manager role",code:"refund_approval_not_permitted",required:config.refundApprovalPermissions},{status:403});
  if(!input.reason||input.reason.trim().length<5)throw Response.json({error:"A clear decision reason is required"},{status:400});
  const amount=input.decision==="no_refund"?0:Math.round(Math.max(0,Number(input.refundAmount||0))*100)/100;
  if(input.decision!=="no_refund"&&amount<=0)throw Response.json({error:"An approved refund needs an amount above zero"},{status:400});
  if(config.requireCustomerCommunication&&!input.communication)throw Response.json({error:"The customer communication must be recorded with the decision"},{status:400});
  const now=input.now??Date.now();
  await db.prepare("UPDATE booking_cancellation_cases SET finance_decision=?,finance_decision_by=?,finance_decision_at=?,finance_decision_reason=?,refund_amount_approved=?,status='closed',closed_at=?,closed_by=?,closed_reason=?,updated_at=? WHERE id=?")
    .bind(input.decision,input.actorId,now,input.reason.trim(),amount,now,input.actorId,input.reason.trim(),now,input.caseId).run();
  await caseEvent(db,{caseId:input.caseId,bookingId:String(row.booking_id),eventType:`finance_${input.decision}`,actorId:input.actorId,reason:input.reason.trim(),evidence:{refundAmountApproved:amount},communication:input.communication,now});
  return{case:(await getCancellationCase(db,input.caseId))!,refundAmountApproved:amount};
}

export async function listCancellationCaseEvents(db:Db,caseId:string){
  await ensureCancellationCaseTables(db);
  const rows=await db.prepare("SELECT * FROM booking_cancellation_case_events WHERE case_id=? ORDER BY occurred_at,id").bind(caseId).all<Row>();
  return rows.results;
}
