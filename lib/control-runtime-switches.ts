type Db=D1Database;
type Row=Record<string,unknown>;
export const CONTROL_SWITCHES=[
 {code:"voice_outbound",label:"Outbound voice",description:"Stops new human and AI outbound call initiation while callbacks remain accepted."},
 {code:"communications_automation",label:"Messaging automation",description:"Stops automated WhatsApp, CRM and outbound bot messaging mutations."},
 {code:"payment_writes",label:"Payments & refunds",description:"Stops new customer checkout, payment and refund mutations while provider webhooks remain accepted."},
 {code:"marketing_writes",label:"Marketing publishing",description:"Stops governed campaign, content, coupon and referral mutations."},
 {code:"provider_auto_assignment",label:"Provider assignment",description:"Stops provider assignment and assignment-recovery mutations."},
 {code:"scheduling_automation",label:"Scheduling automation",description:"Stops new scheduling and scheduling-rule mutations."},
] as const;
export type ControlSwitchCode=(typeof CONTROL_SWITCHES)[number]["code"];
const text=(value:unknown)=>String(value??"").trim();
const PROVIDER_INGRESS=new Set(["/api/razorpay-webhook","/api/razorpayx-webhook","/api/voice-provider-webhook","/api/webhooks/exotel/call-event","/api/provider-verification-callback","/api/communication-provider-callback","/api/whatsapp/meta-webhook","/api/email-provider-webhook","/api/dialler/callback"]);
export async function ensureControlRuntimeTables(db:Db){
 await db.prepare("CREATE TABLE IF NOT EXISTS control_runtime_switches (code TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,reason TEXT NOT NULL DEFAULT 'default enabled',updated_by TEXT NOT NULL DEFAULT 'system',updated_at INTEGER NOT NULL)").run();
 const now=Date.now();for(const item of CONTROL_SWITCHES)await db.prepare("INSERT OR IGNORE INTO control_runtime_switches (code,enabled,reason,updated_by,updated_at) VALUES (?,1,'default enabled','system',?)").bind(item.code,now).run();
}
export async function listControlRuntimeSwitches(db:Db){await ensureControlRuntimeTables(db);const rows=await db.prepare("SELECT code,enabled,reason,updated_by,updated_at FROM control_runtime_switches ORDER BY code").all<Row>();return CONTROL_SWITCHES.map(meta=>{const row=rows.results.find(item=>text(item.code)===meta.code);return{...meta,enabled:Number(row?.enabled??1)===1,reason:text(row?.reason)||"default enabled",updatedBy:text(row?.updated_by)||"system",updatedAt:Number(row?.updated_at||0)}})}
const matches=(code:ControlSwitchCode,path:string)=>{
 if(code==="voice_outbound")return ["/api/voice-outbound","/api/outbound-orchestrator","/api/ai-voice-uat"].includes(path);
 if(code==="communications_automation")return path.startsWith("/api/whatsapp/automation")||["/api/haptik-outbound","/api/crm-automation"].includes(path);
 if(code==="payment_writes")return path==="/api/customer-checkout"||path==="/api/stay-balance"||path==="/api/razorpayx-test-dispatch"||path.includes("payment")||path.includes("refund");
 if(code==="marketing_writes")return ["/api/marketing-control","/api/coupon-governance","/api/referral-governance","/api/content-controls"].includes(path);
 if(code==="provider_auto_assignment")return ["/api/provider-assignment-recovery","/api/provider-capacity-control","/api/uat-provider-switch"].includes(path);
 return ["/api/uat-scheduling","/api/scheduling-rules"].includes(path);
};
export async function runtimeControlBlock(db:Db,request:Request){const method=request.method.toUpperCase(),path=new URL(request.url).pathname;if(["GET","HEAD","OPTIONS"].includes(method)||PROVIDER_INGRESS.has(path)||path==="/api/control-runtime-switches")return null;await ensureControlRuntimeTables(db);for(const item of CONTROL_SWITCHES){if(!matches(item.code,path))continue;const row=await db.prepare("SELECT enabled,reason FROM control_runtime_switches WHERE code=?").bind(item.code).first<Row>();if(Number(row?.enabled??1)===1)return null;return Response.json({error:`Emergency control is active: ${item.code}`,code:"runtime_control_active",control:item.code,reason:text(row?.reason)||"disabled by Control Center"},{status:503,headers:{"cache-control":"no-store"}})}return null}
export async function setControlRuntimeSwitch(db:Db,input:{code:ControlSwitchCode;enabled:boolean;reason:string;actor:string}){await ensureControlRuntimeTables(db);if(!CONTROL_SWITCHES.some(item=>item.code===input.code))throw new Error("Unknown control switch");const reason=input.reason.trim();if(reason.length<5)throw new Error("A reason of at least 5 characters is required");await db.prepare("UPDATE control_runtime_switches SET enabled=?,reason=?,updated_by=?,updated_at=? WHERE code=?").bind(input.enabled?1:0,reason,input.actor,Date.now(),input.code).run();return(await listControlRuntimeSwitches(db)).find(item=>item.code===input.code)!}
