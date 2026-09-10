type Db=D1Database;
type Row=Record<string,unknown>;
export const CONTROL_SWITCHES=[
 {code:"voice_outbound",label:"Outbound voice",description:"Blocks human and AI outbound call initiation."},
 {code:"communications_automation",label:"Messaging automation",description:"Blocks automated WhatsApp/CRM outbound mutations."},
 {code:"payment_writes",label:"Payments & refunds",description:"Blocks payment/refund mutation endpoints while reads remain available."},
 {code:"marketing_writes",label:"Marketing publishing",description:"Blocks campaign, promotion, coupon and referral mutations."},
 {code:"provider_auto_assignment",label:"Provider auto-assignment",description:"Blocks provider assignment/recovery mutations."},
 {code:"scheduling_automation",label:"Scheduling automation",description:"Blocks scheduling and scheduling-rule mutations."},
] as const;
export type ControlSwitchCode=(typeof CONTROL_SWITCHES)[number]["code"];
export async function ensureControlRuntimeTables(db:Db){
 await db.prepare("CREATE TABLE IF NOT EXISTS control_runtime_switches (code TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,reason TEXT NOT NULL DEFAULT 'default enabled',updated_by TEXT NOT NULL DEFAULT 'system',updated_at INTEGER NOT NULL)").run();
 const now=Date.now();
 for(const item of CONTROL_SWITCHES)await db.prepare("INSERT OR IGNORE INTO control_runtime_switches (code,enabled,reason,updated_by,updated_at) VALUES (?,1,'default enabled','system',?)").bind(item.code,now).run();
}
export async function listControlRuntimeSwitches(db:Db){
 await ensureControlRuntimeTables(db);
 const rows=await db.prepare("SELECT code,enabled,reason,updated_by,updated_at FROM control_runtime_switches ORDER BY code").all<Row>();
 return CONTROL_SWITCHES.map(meta=>{const row=rows.results.find(item=>String(item.code)===meta.code);return{...meta,enabled:Number(row?.enabled??1)===1,reason:String(row?.reason||"default enabled"),updatedBy:String(row?.updated_by||"system"),updatedAt:Number(row?.updated_at||0)}});
}
const rules:Array<{code:ControlSwitchCode;match:(path:string)=>boolean}>=[
 {code:"voice_outbound",match:path=>["/api/voice-outbound","/api/outbound-orchestrator","/api/ai-voice-uat"].includes(path)},
 {code:"communications_automation",match:path=>path.startsWith("/api/whatsapp/automation")||path==="/api/haptik-outbound"||path==="/api/crm-automation"},
 {code:"payment_writes",match:path=>path.includes("payment")||path.includes("refund")},
 {code:"marketing_writes",match:path=>["/api/marketing-control","/api/coupon-governance","/api/referral-governance"].includes(path)},
 {code:"provider_auto_assignment",match:path=>path==="/api/provider-assignment-recovery"||path==="/api/provider-capacity-control"},
 {code:"scheduling_automation",match:path=>path==="/api/uat-scheduling"||path==="/api/scheduling-rules"},
];
export async function runtimeControlBlock(db:Db,request:Request){
 if(["GET","HEAD","OPTIONS"].includes(request.method.toUpperCase()))return null;
 const path=new URL(request.url).pathname;
 if(path==="/api/control-center-live")return null;
 const rule=rules.find(item=>item.match(path));
 if(!rule)return null;
 await ensureControlRuntimeTables(db);
 const row=await db.prepare("SELECT enabled,reason FROM control_runtime_switches WHERE code=?").bind(rule.code).first<Row>();
 if(Number(row?.enabled??1)===1)return null;
 return Response.json({error:`Emergency control is active: ${rule.code}`,reason:String(row?.reason||"disabled by Control Center")},{status:503,headers:{"cache-control":"no-store"}});
}
export async function setControlRuntimeSwitch(db:Db,input:{code:ControlSwitchCode;enabled:boolean;reason:string;actor:string}){
 await ensureControlRuntimeTables(db);
 if(!CONTROL_SWITCHES.some(item=>item.code===input.code))throw new Error("Unknown control switch");
 const reason=input.reason.trim();if(reason.length<5)throw new Error("A reason of at least 5 characters is required");
 await db.prepare("UPDATE control_runtime_switches SET enabled=?,reason=?,updated_by=?,updated_at=? WHERE code=?").bind(input.enabled?1:0,reason,input.actor,Date.now(),input.code).run();
 return (await listControlRuntimeSwitches(db)).find(item=>item.code===input.code)!;
}
