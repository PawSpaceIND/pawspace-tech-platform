type Db=D1Database;
type Row=Record<string,unknown>;
export type AutomationDecision={allowed:boolean;reason:string;policyStatus:string;nextEligibleAt:number|null};

export async function ensureCrmAutomationGovernance(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS crm_automation_policy (policy_key TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,quiet_start_hour INTEGER,quiet_end_hour INTEGER,max_contacts INTEGER,window_hours INTEGER,max_attempts INTEGER,retry_minutes INTEGER,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS crm_automation_dispatches (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,journey_code TEXT NOT NULL,channel TEXT NOT NULL,purpose TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER,provider_reference TEXT,last_error TEXT,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS crm_automation_dead_letters (id TEXT PRIMARY KEY,dispatch_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,journey_code TEXT NOT NULL,channel TEXT NOT NULL,reason TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)"),
]);}

export async function automationDecision(db:Db,input:{customerId:string;purpose:"marketing"|"service";channel:string;now?:number}):Promise<AutomationDecision>{
 await ensureCrmAutomationGovernance(db);const now=input.now??Date.now();
 // customer_contact_preferences is owned by the Customer-360 stack; on a cold DB the direct read
 // crashed the whole decision with a 500. A missing table means the same thing as a missing row:
 // no recorded consent (marketing stays blocked below, service contact stays allowed).
 const consentTable=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_contact_preferences'").first<Row>();
 const consent=consentTable?await db.prepare("SELECT marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent FROM customer_contact_preferences WHERE customer_id=?").bind(input.customerId).first<Row>():null;
 // An opt-out recorded ANYWHERE is honoured. The platform keeps two consent stores and each outbound
 // engine used to read only its own: this one reads customer_contact_preferences, while
 // lib/communication-engine.ts reads communication_preferences - and both are written by live surfaces.
 // Measured: a customer opted out of marketing through /api/communications; the governed outbox
 // correctly suppressed the next marketing message as marketing_opt_out, and this engine returned
 // {"allowed":true,"reason":"allowed"} for the same customer, channel and purpose minutes later and
 // queued it. Every campaign run through CRM automation ignored every opt-out ever recorded on the
 // communications preference API, and haptik-outbound and the WhatsApp adapter read the same blind
 // store.
 //
 // Neither table is made the winner here - picking one would silently discard the other's decisions.
 // A recorded opt-out in EITHER store blocks, which fails closed and is the only reading under which
 // consent means anything. Silence in a store is not an opt-out, so a customer who has opted in stays
 // reachable.
 const engineConsent=await db.prepare("SELECT service_updates,marketing FROM communication_preferences WHERE customer_id=?").bind(input.customerId).first<Row>().catch(()=>null);
 if(input.purpose==="marketing"&&Number(engineConsent?.marketing)===0)return{allowed:false,reason:"marketing_opt_out",policyStatus:"blocked",nextEligibleAt:null};
 if(input.purpose==="service"&&Number(engineConsent?.service_updates)===0)return{allowed:false,reason:"service_updates_opt_out",policyStatus:"blocked",nextEligibleAt:null};
 if(input.purpose==="marketing"&&!Boolean(Number(consent?.marketing_consent||0)))return{allowed:false,reason:"marketing_consent_missing",policyStatus:"blocked",nextEligibleAt:null};
 if(input.purpose==="service"&&consent&&Number(consent.service_consent)===0)return{allowed:false,reason:"service_contact_disabled",policyStatus:"blocked",nextEligibleAt:null};
 const channelKey=input.channel==="whatsapp"?"whatsapp_consent":input.channel==="sms"?"sms_consent":input.channel==="email"?"email_consent":null;
 if(channelKey&&consent&&!Boolean(Number(consent[channelKey]||0)))return{allowed:false,reason:`${input.channel}_consent_missing`,policyStatus:"blocked",nextEligibleAt:null};
 const policy=await db.prepare("SELECT * FROM crm_automation_policy WHERE policy_key=?").bind(`${input.purpose}:${input.channel}`).first<Row>();
 if(!policy||Number(policy.enabled)!==1)return{allowed:false,reason:"automation_policy_not_approved",policyStatus:"configuration_required",nextEligibleAt:null};
 if(policy.quiet_start_hour!==null&&policy.quiet_start_hour!==undefined&&policy.quiet_end_hour!==null&&policy.quiet_end_hour!==undefined){const hour=Number(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Kolkata",hour:"2-digit",hour12:false}).format(new Date(now))),start=Number(policy.quiet_start_hour),end=Number(policy.quiet_end_hour),quiet=start<end?(hour>=start&&hour<end):(hour>=start||hour<end);if(quiet)return{allowed:false,reason:"quiet_hours",policyStatus:"approved",nextEligibleAt:null};}
 // Absence and ZERO are different answers. This whole block used to be guarded on the truthiness of
 // max_contacts, so a stored 0 was indistinguishable from NULL/'not configured' and the cap never ran
 // - the STRICTEST setting the API offers produced UNLIMITED dispatches. Measured: policy saved with
 // maxContacts 0, then five queue calls, all five 201 {"queued":true,"reason":"allowed"}; the control
 // with maxContacts 2 capped at two. The write side accepts 0 deliberately - save_policy rejects only
 // negatives - so 0 is a real configured value and now means what it says.
 if(policy.max_contacts!=null&&policy.window_hours!=null){const since=now-Number(policy.window_hours)*3_600_000,count=await db.prepare("SELECT COUNT(*) count FROM crm_automation_dispatches WHERE customer_id=? AND purpose=? AND status IN ('sent','delivered','queued','retry') AND created_at>=?").bind(input.customerId,input.purpose,since).first<{count:number}>();if(Number(count?.count||0)>=Number(policy.max_contacts))return{allowed:false,reason:"frequency_cap",policyStatus:"approved",nextEligibleAt:since+Number(policy.window_hours)*3_600_000};}
 return{allowed:true,reason:"allowed",policyStatus:"approved",nextEligibleAt:now};
}

export async function queueGovernedAutomation(db:Db,input:{customerId:string;journeyCode:string;channel:string;purpose:"marketing"|"service";idempotencyKey:string;now?:number}){
 const now=input.now??Date.now();await ensureCrmAutomationGovernance(db);
 // The idempotent replay must win BEFORE any frequency decision: previously a retry of an
 // already-queued request counted its own first attempt against the frequency cap and was bounced
 // with a spurious 409 instead of the duplicate-prevented response.
 const prior=await db.prepare("SELECT id,status,customer_id,journey_code,channel,purpose FROM crm_automation_dispatches WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();if(prior){if(String(prior.customer_id)!==input.customerId||String(prior.journey_code)!==input.journeyCode||String(prior.channel)!==input.channel||String(prior.purpose)!==input.purpose)throw new Response("Automation idempotency key is already bound to another dispatch",{status:409});return{queued:true,id:String(prior.id),duplicatePrevented:true,decision:{allowed:true,reason:"idempotent_replay",policyStatus:"approved",nextEligibleAt:now} as AutomationDecision,status:String(prior.status)};}
 const decision=await automationDecision(db,{customerId:input.customerId,purpose:input.purpose,channel:input.channel,now});if(!decision.allowed)return{queued:false,decision};
 const id=`AUTO-${crypto.randomUUID().slice(0,12).toUpperCase()}`;try{await db.prepare("INSERT INTO crm_automation_dispatches (id,customer_id,journey_code,channel,purpose,status,attempt_count,next_attempt_at,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'queued',0,?,?,?,?)").bind(id,input.customerId,input.journeyCode,input.channel,input.purpose,now,input.idempotencyKey,now,now).run();}catch(error){if(!(error instanceof Error&&/unique constraint|constraint failed/i.test(error.message)))throw error;const winner=await db.prepare("SELECT id,status,customer_id,journey_code,channel,purpose FROM crm_automation_dispatches WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();if(!winner||String(winner.customer_id)!==input.customerId||String(winner.journey_code)!==input.journeyCode||String(winner.channel)!==input.channel||String(winner.purpose)!==input.purpose)throw new Response("Automation idempotency key is already bound to another dispatch",{status:409});return{queued:true,id:String(winner.id),duplicatePrevented:true,decision:{allowed:true,reason:"idempotent_replay",policyStatus:"approved",nextEligibleAt:now} as AutomationDecision,status:String(winner.status)};}
 // The pre-insert decision is not enough under concurrency: two different journey keys can both count
 // below the cap and then insert. Rank this row by SQLite insertion order after the write; whichever
 // request crosses the configured rolling-window cap is retained as suppressed evidence, not queued.
 const policy=await db.prepare("SELECT max_contacts,window_hours FROM crm_automation_policy WHERE policy_key=?").bind(`${input.purpose}:${input.channel}`).first<Row>();if(policy?.max_contacts!=null&&policy?.window_hours!=null){const since=now-Number(policy.window_hours)*3_600_000,rank=await db.prepare("SELECT COUNT(*) count FROM crm_automation_dispatches WHERE customer_id=? AND purpose=? AND status IN ('sent','delivered','queued','retry') AND created_at>=? AND rowid<=(SELECT rowid FROM crm_automation_dispatches WHERE id=?)").bind(input.customerId,input.purpose,since,id).first<{count:number}>();if(Number(rank?.count||0)>Number(policy.max_contacts)){await db.prepare("UPDATE crm_automation_dispatches SET status='suppressed_frequency_cap',next_attempt_at=NULL,updated_at=? WHERE id=? AND status='queued'").bind(now,id).run();return{queued:false,id,duplicatePrevented:false,decision:{allowed:false,reason:"frequency_cap",policyStatus:"approved",nextEligibleAt:since+Number(policy.window_hours)*3_600_000} as AutomationDecision,status:"suppressed_frequency_cap"};}}
 return{queued:true,id,duplicatePrevented:false,decision,status:"queued"};
}

export async function recordAutomationFailure(db:Db,dispatchId:string,error:string,actor:string){await ensureCrmAutomationGovernance(db);const row=await db.prepare("SELECT * FROM crm_automation_dispatches WHERE id=?").bind(dispatchId).first<Row>();if(!row)throw new Error("Automation dispatch not found");const policy=await db.prepare("SELECT * FROM crm_automation_policy WHERE policy_key=?").bind(`${String(row.purpose)}:${String(row.channel)}`).first<Row>(),now=Date.now(),attempts=Number(row.attempt_count||0)+1,maxAttempts=Number(policy?.max_attempts||0),retryMinutes=Number(policy?.retry_minutes||0);
 if(!policy||Number(policy.enabled)!==1||maxAttempts<1||retryMinutes<1){await db.batch([db.prepare("UPDATE crm_automation_dispatches SET status='dead_letter',attempt_count=?,last_error=?,next_attempt_at=NULL,updated_at=? WHERE id=?").bind(attempts,error,now,dispatchId),db.prepare("INSERT OR IGNORE INTO crm_automation_dead_letters (id,dispatch_id,customer_id,journey_code,channel,reason,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`DLQ-${crypto.randomUUID().slice(0,12).toUpperCase()}`,dispatchId,row.customer_id,row.journey_code,row.channel,"retry_policy_not_configured",JSON.stringify({error,actor,attempts}),now)]);return{status:"dead_letter",attempts,reason:"retry_policy_not_configured"};}
 if(attempts>=maxAttempts){await db.batch([db.prepare("UPDATE crm_automation_dispatches SET status='dead_letter',attempt_count=?,last_error=?,next_attempt_at=NULL,updated_at=? WHERE id=?").bind(attempts,error,now,dispatchId),db.prepare("INSERT OR IGNORE INTO crm_automation_dead_letters (id,dispatch_id,customer_id,journey_code,channel,reason,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`DLQ-${crypto.randomUUID().slice(0,12).toUpperCase()}`,dispatchId,row.customer_id,row.journey_code,row.channel,"retry_exhausted",JSON.stringify({error,actor,attempts,maxAttempts}),now)]);return{status:"dead_letter",attempts,reason:"retry_exhausted"};}
 const next=now+retryMinutes*60_000;await db.prepare("UPDATE crm_automation_dispatches SET status='retry',attempt_count=?,last_error=?,next_attempt_at=?,updated_at=? WHERE id=?").bind(attempts,error,next,now,dispatchId).run();return{status:"retry",attempts,nextAttemptAt:next};}
