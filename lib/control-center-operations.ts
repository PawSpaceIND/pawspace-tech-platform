type Db=D1Database; type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"");
async function exists(db:Db,table:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first());}
async function count(db:Db,table:string,where="",binds:unknown[]=[]){if(!await exists(db,table))return null;return Number((await db.prepare(`SELECT COUNT(*) count FROM ${table}${where?` WHERE ${where}`:""}`).bind(...binds).first<Row>())?.count||0)}
async function recent(db:Db,table:string,columns:string,order:string,limit=8){if(!await exists(db,table))return[];const sql="SELECT "+columns+" FROM "+table+" ORDER BY "+order+" DESC LIMIT ?";return(await db.prepare(sql).bind(limit).all<Row>()).results}
const card=(label:string,value:number|null,detail:string,source:string)=>({label,value,detail,source,connected:value!==null});
export type ControlOpsMode="approvals"|"master"|"inventory"|"quality"|"security"|"health"|"audit";
export async function buildControlCenterOperations(db:Db,mode:ControlOpsMode){
 if(mode==="approvals"){
  const board=await count(db,"board_approvals","status NOT IN ('approved','rejected','closed')"),payments=await count(db,"elite_payment_approval_queue","status NOT IN ('approved','rejected','completed')"),payouts=await count(db,"partner_payout_instruction_approvals","status NOT IN ('approved','rejected','completed')"),payroll=await count(db,"payroll_approval_events","outcome NOT IN ('approved','rejected','completed')"),providers=await count(db,"provider_onboarding_applications","human_decision IS NULL AND status NOT IN ('rejected','withdrawn')");
  return{mode,title:"Approvals",cards:[card("Board",board,"Open board decisions","board_approvals"),card("Payments",payments,"Money actions awaiting decision","elite_payment_approval_queue"),card("Partner payouts",payouts,"Payout instructions awaiting approval","partner_payout_instruction_approvals"),card("Provider onboarding",providers,"Applications without a human decision","provider_onboarding_applications"),card("Payroll",payroll,"Unresolved payroll approval events","payroll_approval_events")],rows:await recent(db,"board_approvals","id,status,created_at","created_at")};
 }
 if(mode==="master"){
  const specs:[[string,string,string,string?],...Array<[string,string,string,string?]>]=[["Cities","city_launch_configs","City launch configurations"],["Services","service_controls","Service controls"],["Policies","service_policy_configs","Service policy versions"],["Packages","service_packages","Canonical service packages"],["Price rules","dynamic_pricing_rules","Dynamic pricing rules"],["Subscription plans","grooming_subscription_plans","Grooming subscription plans"]];
  return{mode,title:"Master configuration",cards:await Promise.all(specs.map(async([l,t,d])=>card(l,await count(db,t),d,t))),rows:[]};
 }
 if(mode==="inventory"){
  return{mode,title:"Inventory & buying",cards:[card("Food SKUs",await count(db,"food_inventory_uat"),"Canonical UAT inventory rows","food_inventory_uat"),card("Active reservations",await count(db,"food_inventory_reservations","status NOT IN ('released','consumed','cancelled')"),"Stock reserved by live order flows","food_inventory_reservations")],rows:await recent(db,"food_inventory_uat","*","updated_at")};
 }
 if(mode==="quality"){
  const tables=["boarding_incidents","sitting_incidents","walking_incidents","taxi_incidents","food_quality_incidents"];
  const cards=[] as ReturnType<typeof card>[]; for(const t of tables)cards.push(card(t.replaceAll("_"," "),await count(db,t,"status NOT IN ('resolved','closed')"),"Open governed incidents",t));
  cards.push(card("Safety cases",await count(db,"unified_cases","case_type='safety_incident' AND status NOT IN ('resolved','closed')"),"Cross-service safety cases","unified_cases"));
  return{mode,title:"Quality & incidents",cards,rows:await recent(db,"unified_cases","id,case_type,severity,status,title,owner_team,created_at","created_at")};
 }
 if(mode==="security"){
  return{mode,title:"Privacy & security",cards:[card("Security audit",await count(db,"security_audit_events"),"Recorded governed access/actions","security_audit_events"),card("Audit outbox",await count(db,"security_audit_outbox","status!='completed'"),"Audit writes not finalized","security_audit_outbox"),card("DPDP erasures",await count(db,"dpdp_erasure_requests"),"Governed erasure requests","dpdp_erasure_requests")],rows:await recent(db,"security_audit_events","actor_email,action,resource_type,resource_id,outcome,created_at","created_at")};
 }
 if(mode==="health"){
  return{mode,title:"System health",cards:[card("Integrations",await count(db,"integration_registry"),"Registered external integrations","integration_registry"),card("Integration blockers",await count(db,"integration_registry","required=1 AND readiness_state NOT IN ('sandbox_verified','controlled_live_verified')"),"Required integrations below verified state","integration_registry"),card("Outbox pending",await count(db,"communication_outbox","status IN ('pending','retry')"),"Messages awaiting delivery","communication_outbox"),card("Dead letters",await count(db,"communication_dead_letters","status NOT IN ('resolved','closed')"),"Communication failures needing recovery","communication_dead_letters"),card("Outbound queue",await count(db,"outbound_routing_queue","status IN ('queued','claimed','dialing')"),"Sales/AI outbound work in progress","outbound_routing_queue")],rows:await recent(db,"integration_registry","integration_code,category,provider,readiness_state,blocker_reason,updated_at","updated_at")};
 }
 const auditRows=await recent(db,"security_audit_events","actor_email,action,resource_type,resource_id,outcome,created_at","created_at",12);
 return{mode,title:"Platform audit & release",cards:[card("Governed changes",await count(db,"security_audit_events"),"Canonical security audit events","security_audit_events"),card("Integration evidence",await count(db,"integration_live_evidence"),"Durable provider/runtime evidence","integration_live_evidence"),card("Readiness events",await count(db,"integration_readiness_events"),"Governed readiness transitions","integration_readiness_events"),card("Evidence requests",await count(db,"integration_evidence_requests","satisfied_at IS NULL"),"Outstanding evidence requests","integration_evidence_requests")],rows:auditRows};
}
export const controlCenterRowText=(row:Row)=>Object.entries(row).map(([k,v])=>`${k}: ${text(v)}`).join(" · ");
