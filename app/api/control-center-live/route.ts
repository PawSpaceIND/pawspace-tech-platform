import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{setControlRuntimeSwitch,listControlRuntimeSwitches,type ControlSwitchCode}from"../../../lib/control-runtime-switches";
type Db=D1Database;type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const sameOrigin=(request:Request)=>{const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin control write blocked",{status:403});};
const text=(v:unknown)=>String(v??"").trim();
async function exists(db:Db,table:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first<Row>());}
async function scalar(db:Db,table:string,sql:string,binds:unknown[]=[]){if(!await exists(db,table))return null;const row=await db.prepare(sql).bind(...binds).first<Row>();return Number(row?.count??0);}
async function rows(db:Db,table:string,sql:string,binds:unknown[]=[]){if(!await exists(db,table))return[] as Row[];return(await db.prepare(sql).bind(...binds).all<Row>()).results;}
async function ensureInventory(db:Db){await db.prepare("CREATE TABLE IF NOT EXISTS control_inventory_items (id TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,on_hand REAL NOT NULL DEFAULT 0,reorder_at REAL NOT NULL DEFAULT 0,unit TEXT NOT NULL DEFAULT 'units',vendor TEXT,status TEXT NOT NULL DEFAULT 'active',updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)").run();}
function metric(label:string,value:number|null,detail:string,view:string){return{label,value,connected:value!==null,detail,view};}
async function snapshot(db:Db){
 await ensureInventory(db);
 const now=Date.now(),soon=now+30*86400000;
 const [switches,inventory]=await Promise.all([listControlRuntimeSwitches(db),rows(db,"control_inventory_items","SELECT * FROM control_inventory_items WHERE status='active' ORDER BY CASE WHEN on_hand<=reorder_at THEN 0 ELSE 1 END,name LIMIT 100")]);
 const approvals=[
  metric("Provider decisions",await scalar(db,"provider_onboarding_applications","SELECT COUNT(*) count FROM provider_onboarding_applications WHERE human_decision IS NULL AND status NOT IN ('rejected','withdrawn')"),"Applications awaiting named human decision","approvals"),
  metric("Payment approvals",await scalar(db,"elite_payment_approval_queue","SELECT COUNT(*) count FROM elite_payment_approval_queue WHERE status IN ('pending','open')"),"Money actions waiting for approval","approvals"),
  metric("Board approvals",await scalar(db,"board_approvals","SELECT COUNT(*) count FROM board_approvals WHERE status IN ('pending','open')"),"Governance decisions awaiting approval","approvals")];
 const master=[
  metric("Service policies",await scalar(db,"service_policy_configs","SELECT COUNT(*) count FROM service_policy_configs"),"Server-enforced service policy records","master"),
  metric("Pricing rules",await scalar(db,"dynamic_pricing_rules","SELECT COUNT(*) count FROM dynamic_pricing_rules WHERE status!='archived'"),"Versioned pricing configuration","pricing"),
  metric("City configs",await scalar(db,"city_launch_configs","SELECT COUNT(*) count FROM city_launch_configs"),"City and geofence launch configuration","cities"),
  metric("Scheduling rules",await scalar(db,"scheduling_rules","SELECT COUNT(*) count FROM scheduling_rules"),"Server-side scheduling constraints","scheduling")];
 const quality=[
  metric("Open customer cases",await scalar(db,"unified_cases","SELECT COUNT(*) count FROM unified_cases WHERE status NOT IN ('resolved','closed')"),"Cross-service cases requiring action","quality"),
  metric("Boarding incidents",await scalar(db,"boarding_incidents","SELECT COUNT(*) count FROM boarding_incidents WHERE status NOT IN ('resolved','closed')"),"Open boarding safety incidents","quality"),
  metric("Sitting incidents",await scalar(db,"sitting_incidents","SELECT COUNT(*) count FROM sitting_incidents WHERE status NOT IN ('resolved','closed')"),"Open sitting safety incidents","quality"),
  metric("Food incidents",await scalar(db,"food_quality_incidents","SELECT COUNT(*) count FROM food_quality_incidents WHERE status NOT IN ('resolved','closed')"),"Open food-quality incidents","quality")];
 const security=[
  metric("Active staff identities",await scalar(db,"app_users","SELECT COUNT(*) count FROM app_users WHERE status='active'"),"Provisioned active workspace users","security"),
  metric("Denied access · 24h",await scalar(db,"security_audit_events","SELECT COUNT(*) count FROM security_audit_events WHERE outcome='denied' AND created_at>=?",[now-86400000]),"Server-side authorization denials","security"),
  metric("Security audit events · 24h",await scalar(db,"security_audit_events","SELECT COUNT(*) count FROM security_audit_events WHERE created_at>=?",[now-86400000]),"Audited privileged activity","security")];
 const health=[
  metric("Integration blockers",await scalar(db,"integration_registry","SELECT COUNT(*) count FROM integration_registry WHERE readiness_state NOT IN ('sandbox_verified','controlled_live_verified')"),"Integrations without verified readiness","health"),
  metric("Communication retry / DLQ",await scalar(db,"communication_outbox","SELECT COUNT(*) count FROM communication_outbox WHERE status IN ('retry_pending','dlq','failed')"),"Outbound communication failures requiring recovery","health"),
  metric("Payment reconciliation open",await scalar(db,"payment_reconciliation_exceptions","SELECT COUNT(*) count FROM payment_reconciliation_exceptions WHERE status='open'"),"Unresolved payment reconciliation exceptions","finance"),
  metric("Overdue staff alerts",await scalar(db,"staff_alerts","SELECT COUNT(*) count FROM staff_alerts WHERE status='open' AND due_at<=?",[now]),"Operational alerts beyond due time","health")];
 const subscriptions=[
  metric("Active subscriptions",await scalar(db,"customer_grooming_subscriptions","SELECT COUNT(*) count FROM customer_grooming_subscriptions WHERE status='active'"),"Canonical grooming subscription wallets","subscriptions"),
  metric("Renewal due ≤30d",await scalar(db,"customer_grooming_subscriptions","SELECT COUNT(*) count FROM customer_grooming_subscriptions WHERE status='active' AND expires_at BETWEEN ? AND ?",[now,soon]),"Real expiry-based renewal worklist","subscriptions"),
  metric("Payment / entitlement exceptions",await scalar(db,"customer_grooming_subscriptions","SELECT COUNT(*) count FROM customer_grooming_subscriptions WHERE status IN ('payment_failed','refund_pending')"),"Subscription money or entitlement exceptions","subscriptions")];
 const marketing=[
  metric("Governed campaigns",await scalar(db,"governed_marketing_campaigns","SELECT COUNT(*) count FROM governed_marketing_campaigns"),"Campaigns persisted in marketing governance","marketing"),
  metric("Active campaigns",await scalar(db,"governed_marketing_campaigns","SELECT COUNT(*) count FROM governed_marketing_campaigns WHERE status='active'"),"Campaigns currently activated through approval flow","marketing"),
  metric("Governed promotions",await scalar(db,"governed_marketing_promotions","SELECT COUNT(*) count FROM governed_marketing_promotions"),"Promotion experiments persisted server-side","marketing"),
  metric("Ad reports captured",await scalar(db,"marketing_ad_report_runs","SELECT COUNT(*) count FROM marketing_ad_report_runs"),"Connector/import reports stored for measurement","marketing")];
 const modules=[
  metric("CRM active leads",await scalar(db,"lead_work_items","SELECT COUNT(*) count FROM lead_work_items WHERE status='active'"),"CRM lead work currently active","data2"),
  metric("Human dialler queue",await scalar(db,"outbound_routing_queue","SELECT COUNT(*) count FROM outbound_routing_queue WHERE lane='human' AND status='queued'"),"High-intent leads waiting for people","data2"),
  metric("Canonical bookings open",await scalar(db,"canonical_bookings","SELECT COUNT(*) count FROM canonical_bookings WHERE status NOT IN ('completed','cancelled','refunded')"),"Bookings still in the operating lifecycle","lifecycle"),
  metric("Provider onboarding waiting",await scalar(db,"provider_onboarding_applications","SELECT COUNT(*) count FROM provider_onboarding_applications WHERE human_decision IS NULL AND status NOT IN ('rejected','withdrawn')"),"Providers awaiting human activation decision","approvals"),
  metric("WhatsApp / comm pending",await scalar(db,"communication_outbox","SELECT COUNT(*) count FROM communication_outbox WHERE status IN ('queued','scheduled','retry_pending')"),"Messages waiting for governed delivery","health")];
 const audit=[...health,...quality,...approvals,...modules];
 return{generatedAt:now,switches,inventory,sections:{approvals,master,quality,security,health,subscriptions,marketing,audit,modules}};
}
export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"audit.view");const db=await database();return json({data:await snapshot(db)});}catch(error){return authError(error,"Unable to load live Control Center");}}
export async function POST(request:Request){try{
 sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"settings.manage");const db=await database();const body=await request.json().catch(()=>({})) as Record<string,unknown>;const action=text(body.action);
 if(action==="set_runtime_switch"){
  const code=text(body.code) as ControlSwitchCode,enabled=Boolean(body.enabled),reason=text(body.reason);
  const data=await setControlRuntimeSwitch(db,{code,enabled,reason,actor:actor.email});
  await securityAudit(db,actor,"control.runtime_switch","control_runtime_switch",code,"completed",{enabled,reason});
  return json({data});
 }
 if(action==="save_inventory_item"){
  await ensureInventory(db);const id=text(body.id)||`INV-${crypto.randomUUID().slice(0,8)}`,name=text(body.name),category=text(body.category)||"general",unit=text(body.unit)||"units",vendor=text(body.vendor),onHand=Number(body.onHand),reorderAt=Number(body.reorderAt);
  if(!name||!Number.isFinite(onHand)||onHand<0||!Number.isFinite(reorderAt)||reorderAt<0)return json({error:"Name, non-negative on-hand and reorder values are required"},400);
  await db.prepare("INSERT INTO control_inventory_items (id,name,category,on_hand,reorder_at,unit,vendor,status,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,on_hand=excluded.on_hand,reorder_at=excluded.reorder_at,unit=excluded.unit,vendor=excluded.vendor,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(id,name,category,onHand,reorderAt,unit,vendor||null,actor.email,Date.now()).run();
  await securityAudit(db,actor,"control.inventory.save","inventory",id,"completed",{category,onHand,reorderAt,unit});
  return json({data:await snapshot(db)},201);
 }
 return json({error:"Unsupported Control Center action"},400);
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to update live Control Center");}}
