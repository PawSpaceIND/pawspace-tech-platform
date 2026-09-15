type Db=D1Database; type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"");
async function exists(db:Db,table:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first());}
/*
 * ONE WORD PER FACT.
 *
 * Both helpers used to collapse several different situations into one indistinguishable answer, and
 * the screen then had to invent a single sentence to cover all of them. count() returned null whether
 * the table was absent or the predicate named a column that does not exist, and the card said "not
 * connected" for both. recent() returned [] whether the table was absent, the select list had
 * drifted, or the query genuinely came back empty - and the panel said "No recent records in this
 * source." for all three, which is a POSITIVE claim about a query that in two of those three cases
 * never ran. On Quality & incidents that produced a screen contradicting itself: every card read
 * "n/c - not connected" and the evidence list underneath read "No recent records in this source",
 * about unified_cases, a table sqlite_master had just said does not exist.
 *
 * So each helper now names which of these happened, and every name is a fact this process has just
 * established for itself:
 *
 *   ok             the query ran and answered.
 *   empty          the query RAN against a table that is there, and returned no rows.  (evidence only)
 *   uninitialised  sqlite_master has no such table on THIS database, right now.
 *   unreadable     the table is there and the query failed with `no such column` - real schema drift.
 *   not_queried    this view issues no evidence query at all.                          (evidence only)
 *
 * "uninitialised", not "not connected". Every table named in this file has a canonical CREATE TABLE
 * in shipping code - tests/control-center-column-contract.test.mjs (CC-3) fails if one does not - and
 * those statements are CREATE TABLE IF NOT EXISTS, run by the module that owns the domain on its
 * first use. A table missing from a cold worker is therefore a table nothing has touched yet, not a
 * part of the platform that is disconnected. Observed directly: within one session, with no deploy
 * and no schema change, Cities, Packages, Price rules, Integrations, Integration blockers and Outbox
 * pending went from "not connected" to real counts purely because unrelated screens ran their own
 * ensure step. "not connected" was describing this worker's warm-up and stating it as a fact about
 * the platform.
 *
 * The Control Center does NOT fix that by creating the tables. It is a reader; a reader that writes
 * to the database so its own output looks better is a worse defect than the copy it would be fixing.
 * It fixes it by saying the true thing instead.
 *
 * The `no such column` tolerance is NOT widened here, and is now louder than it was. It is still the
 * only D1 failure either helper absorbs (a missing TABLE is handled by exists(); everything else
 * propagates and the route returns 500) and it is still capped so one drifted column cannot take down
 * six working cards - but both helpers now log it, both surface it as a state of its own carrying the
 * D1 message, and the panel renders that state as an error rather than as a calm dash. Tolerating it
 * and hiding it were two separate decisions; only the first one was ever wanted.
 *
 * That signal is still paid back by tests/control-center-column-contract.test.mjs, which checks EVERY
 * column this module names - recent()'s select lists AND count()'s predicates - against the canonical
 * CREATE TABLE for that table and fails on any column that does not exist. An earlier note here
 * credited the approvals/onboarding suite with that cover; it did not have it. It pinned recent()'s
 * columns only, so three count() predicates naming columns their tables never had -
 * payroll_approval_events.outcome, partner_payout_instruction_approvals.status and
 * communication_dead_letters.status - sat on these very lines while that suite passed 17/17, each one
 * rendering as a calm "not connected" while real work queued up behind it.
 */
export type SourceState="ok"|"uninitialised"|"unreadable";
export type EvidenceState="rows"|"empty"|"uninitialised"|"unreadable"|"not_queried";
type Reading={value:number|null;state:SourceState;note:string};
type EvidenceQuery={state:EvidenceState;source:string|null;note:string;rows:Row[]};
export type EvidenceReport={state:EvidenceState;source:string|null;note:string};
const uninitialisedNote=(table:string)=>`${table} has not been created on this database yet, so nothing was queried. It is declared in the platform schema and the module that owns it creates it on first use - this is an uninitialised source, not a disconnected one.`;
const unreadableNote=(table:string,queried:string,message:string)=>`${table} exists but does not have every column this view queries (${queried}), so the query failed and nothing was read. D1 reported: ${message}`;
const columnDrift=(error:unknown)=>{const message=error instanceof Error?error.message:String(error);return /no such column/i.test(message)?message:null;};
async function count(db:Db,table:string,where="",binds:unknown[]=[]):Promise<Reading>{
 if(!await exists(db,table))return{value:null,state:"uninitialised",note:uninitialisedNote(table)};
 try{return{value:Number((await db.prepare(`SELECT COUNT(*) count FROM ${table}${where?` WHERE ${where}`:""}`).bind(...binds).first<Row>())?.count||0),state:"ok",note:""}}
 catch(error){const message=columnDrift(error);if(message===null)throw error;
  console.error("[control-center] count unavailable - schema drift",{table,where,message});
  return{value:null,state:"unreadable",note:unreadableNote(table,where||"COUNT(*)",message)}}
}
async function recent(db:Db,table:string,columns:string,order:string,limit=8):Promise<EvidenceQuery>{
 if(!await exists(db,table))return{state:"uninitialised",source:table,note:uninitialisedNote(table),rows:[]};
 const sql="SELECT "+columns+" FROM "+table+" ORDER BY "+order+" DESC LIMIT ?";
 try{const rows=(await db.prepare(sql).bind(limit).all<Row>()).results;
  return rows.length
   ?{state:"rows",source:table,note:`${rows.length} most recent row${rows.length===1?"":"s"} read from ${table}.`,rows}
   :{state:"empty",source:table,note:`${table} was queried and holds no rows.`,rows:[]}}
 catch(error){const message=columnDrift(error);if(message===null)throw error;
  console.error("[control-center] evidence rows unavailable - schema drift",{table,columns,message});
  return{state:"unreadable",source:table,note:unreadableNote(table,columns,message),rows:[]}}
}
/* A view with no evidence table of its own. Master configuration summarises several independent
 * configuration tables and issues no evidence query; it used to hand the panel a hardcoded [], which
 * the panel then reported as "No recent records in this source." over the 112 rows the cards on the
 * very same screen had just counted. Saying so is the fix. Inventing an evidence query over one of
 * the six and presenting its rows as this view's evidence would only be a different untrue thing, and
 * would add D1 subrequests to a read path to do it. */
const notQueried=(note:string):EvidenceQuery=>({state:"not_queried",source:null,note,rows:[]});
const card=(label:string,reading:Reading,detail:string,source:string)=>({label,value:reading.value,detail,source,connected:reading.state==="ok",state:reading.state,note:reading.note});
/* `rows` stays on the payload exactly as it was - the panel and the pinned suites read it - and
 * `evidence` carries why it looks the way it does. The rows live in one place, not both. */
const view=(mode:ControlOpsMode,title:string,cards:ReturnType<typeof card>[],evidence:EvidenceQuery)=>
 ({mode,title,cards,rows:evidence.rows,evidence:{state:evidence.state,source:evidence.source,note:evidence.note} as EvidenceReport});
export type ControlOpsMode="approvals"|"master"|"inventory"|"quality"|"security"|"health"|"audit";
export async function buildControlCenterOperations(db:Db,mode:ControlOpsMode){
 if(mode==="approvals"){
  const board=await count(db,"board_approvals"),payments=await count(db,"elite_payment_approval_queue","status NOT IN ('approved','rejected','completed')"),payouts=await count(db,"partner_payout_instruction_approvals","level_2_at IS NULL"),payroll=await count(db,"payroll_runs","status NOT IN ('approved','payment_prepared')"),providers=await count(db,"provider_onboarding_applications","human_decision IS NULL AND status NOT IN ('rejected','withdrawn')");
  return view(mode,"Approvals",[card("Board",board,"Board resolutions on record \u2014 this ledger stores approvals only, it has no pending state","board_approvals"),card("Payments",payments,"Money actions awaiting decision","elite_payment_approval_queue"),card("Partner payouts",payouts,"Payout instructions awaiting second-level approval","partner_payout_instruction_approvals"),card("Provider onboarding",providers,"Applications without a human decision","provider_onboarding_applications"),card("Payroll",payroll,"Payroll runs not yet approved","payroll_runs")],await recent(db,"board_approvals","id,period,resolution_type,approved_by,approver_role,approved_at,created_at","created_at"));
 }
 if(mode==="master"){
  const specs:[[string,string,string,string?],...Array<[string,string,string,string?]>]=[["Cities","city_launch_configs","City launch configurations"],["Services","service_controls","Service controls"],["Policies","service_policy_configs","Service policy versions"],["Packages","service_packages","Canonical service packages"],["Price rules","dynamic_pricing_rules","Dynamic pricing rules"],["Subscription plans","grooming_subscription_plans","Grooming subscription plans"]];
  const cards=await Promise.all(specs.map(async([l,t,d])=>card(l,await count(db,t),d,t)));
  const answered=cards.filter(c=>c.state==="ok"),total=answered.reduce((sum,c)=>sum+(c.value??0),0);
  return view(mode,"Master configuration",cards,notQueried(`This view summarises ${specs.length} independent configuration tables and issues no evidence query of its own - ${answered.length} of them answered, holding ${total} row${total===1?"":"s"} between them, each counted on its own card above. There is no single recent-records list behind this view, and none is claimed.`));
 }
 if(mode==="inventory"){
  return view(mode,"Inventory & buying",[card("Food SKUs",await count(db,"food_inventory_uat"),"Canonical UAT inventory rows","food_inventory_uat"),card("Active reservations",await count(db,"food_inventory_reservations","status NOT IN ('released','consumed','cancelled')"),"Stock reserved by live order flows","food_inventory_reservations")],await recent(db,"food_inventory_uat","*","updated_at"));
 }
 if(mode==="quality"){
  const tables=["boarding_incidents","sitting_incidents","walking_incidents","taxi_incidents","food_quality_incidents"];
  const cards=[] as ReturnType<typeof card>[]; for(const t of tables)cards.push(card(t.replaceAll("_"," "),await count(db,t,"status NOT IN ('resolved','closed')"),"Open governed incidents",t));
  cards.push(card("Safety cases",await count(db,"unified_cases","case_type='safety_incident' AND status NOT IN ('resolved','closed')"),"Cross-service safety cases","unified_cases"));
  return view(mode,"Quality & incidents",cards,await recent(db,"unified_cases","id,case_type,severity,status,title,owner_team,created_at","created_at"));
 }
 if(mode==="security"){
  return view(mode,"Privacy & security",[card("Security audit",await count(db,"security_audit_events"),"Recorded governed access/actions","security_audit_events"),card("Audit outbox",await count(db,"security_audit_outbox","status!='completed'"),"Audit writes not finalized","security_audit_outbox"),card("DPDP erasures",await count(db,"dpdp_erasure_requests"),"Governed erasure requests","dpdp_erasure_requests")],await recent(db,"security_audit_events","actor_email,action,resource_type,resource_id,outcome,created_at","created_at"));
 }
 if(mode==="health"){
  return view(mode,"System health",[card("Integrations",await count(db,"integration_registry"),"Registered external integrations","integration_registry"),card("Integration blockers",await count(db,"integration_registry","required=1 AND readiness_state NOT IN ('sandbox_verified','controlled_live_verified')"),"Required integrations below verified state","integration_registry"),card("Outbox pending",await count(db,"communication_outbox","status IN ('pending','retry')"),"Messages awaiting delivery","communication_outbox"),card("Dead letters",await count(db,"communication_dead_letters","resolved_at IS NULL"),"Communication failures needing recovery","communication_dead_letters"),card("Outbound queue",await count(db,"outbound_routing_queue","status IN ('queued','claimed','dialing')"),"Sales/AI outbound work in progress","outbound_routing_queue")],await recent(db,"integration_registry","integration_code,category,provider,readiness_state,blocker_reason,updated_at","updated_at"));
 }
 const auditRows=await recent(db,"security_audit_events","actor_email,action,resource_type,resource_id,outcome,created_at","created_at",12);
 return view(mode,"Platform audit & release",[card("Governed changes",await count(db,"security_audit_events"),"Canonical security audit events","security_audit_events"),card("Integration evidence",await count(db,"integration_live_evidence"),"Durable provider/runtime evidence","integration_live_evidence"),card("Readiness events",await count(db,"integration_readiness_events"),"Governed readiness transitions","integration_readiness_events"),card("Evidence requests",await count(db,"integration_evidence_requests","satisfied_at IS NULL"),"Outstanding evidence requests","integration_evidence_requests")],auditRows);
}
export const controlCenterRowText=(row:Row)=>Object.entries(row).map(([k,v])=>`${k}: ${text(v)}`).join(" · ");
