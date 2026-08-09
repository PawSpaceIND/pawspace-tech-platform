export const pawspaceServices=[
 {code:"grooming",name:"Grooming",group:"Care"},
 {code:"dog_training",name:"Training",group:"Care"},
 {code:"boarding",name:"Boarding",group:"Care"},
 {code:"pet_sitting",name:"Pet Sitting",group:"Care"},
 {code:"pet_taxi",name:"Pet Taxi",group:"Mobility"},
 {code:"dog_walking",name:"Dog Walking",group:"Care"},
 {code:"food",name:"Pet Food",group:"Commerce"},
 {code:"relocation",name:"Pet Relocation",group:"Special services"},
 {code:"funeral_memorial",name:"Funeral & Memorial",group:"Special services"},
] as const;
export type PawSpaceServiceCode=(typeof pawspaceServices)[number]["code"];
export type ServiceControl={code:PawSpaceServiceCode;name:string;group:string;enabled:boolean;disabledReason:string|null;updatedBy:string;updatedAt:number};
type Stored={service_code:string;service_name:string;service_group:string;enabled:number;disabled_reason:string|null;updated_by:string;updated_at:number};
const schedulingMap:Record<string,PawSpaceServiceCode>={grooming:"grooming",dog_training:"dog_training",boarding:"boarding",pet_sitting:"pet_sitting",pet_taxi:"pet_taxi",dog_walking:"dog_walking"};
const commercialRequestPaths:Record<string,PawSpaceServiceCode>={"/api/training-commercial":"dog_training","/api/boarding-commercial":"boarding","/api/sitting-commercial":"pet_sitting","/api/taxi-commercial":"pet_taxi","/api/walking-commercial":"dog_walking","/api/food-commercial":"food"};
export function isPawSpaceServiceCode(value:string):value is PawSpaceServiceCode{return pawspaceServices.some(service=>service.code===value)}
export async function ensureServiceControlTables(db:D1Database){const now=Date.now();await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS service_controls (service_code TEXT PRIMARY KEY,service_name TEXT NOT NULL,service_group TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,disabled_reason TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS service_control_audit_events (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,from_enabled INTEGER NOT NULL,to_enabled INTEGER NOT NULL,reason TEXT NOT NULL,actor_email TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);await db.batch(pawspaceServices.map(service=>db.prepare("INSERT OR IGNORE INTO service_controls (service_code,service_name,service_group,enabled,disabled_reason,updated_by,updated_at) VALUES (?,?,?,1,NULL,'system',?)").bind(service.code,service.name,service.group,now)))}
export async function listServiceControls(db:D1Database):Promise<ServiceControl[]>{await ensureServiceControlTables(db);const rows=await db.prepare("SELECT service_code,service_name,service_group,enabled,disabled_reason,updated_by,updated_at FROM service_controls").all<Stored>(),byCode=new Map(rows.results.map(row=>[row.service_code,row]));return pawspaceServices.map(service=>{const row=byCode.get(service.code);return{code:service.code,name:service.name,group:service.group,enabled:row?Boolean(row.enabled):true,disabledReason:row?.disabled_reason??null,updatedBy:row?.updated_by??"system",updatedAt:Number(row?.updated_at||0)}})}
export async function setServiceEnabled(db:D1Database,input:{serviceCode:PawSpaceServiceCode;enabled:boolean;reason:string;actorEmail:string}){await ensureServiceControlTables(db);const definition=pawspaceServices.find(service=>service.code===input.serviceCode);if(!definition)throw new Error("Unknown PawSpace service");const reason=input.reason.trim(),now=Date.now(),current=await db.prepare("SELECT enabled FROM service_controls WHERE service_code=?").bind(input.serviceCode).first<{enabled:number}>(),fromEnabled=current?Boolean(current.enabled):true;if(!input.enabled&&reason.length<8)throw new Error("A clear reason of at least 8 characters is required before disabling a service");const auditReason=reason||(input.enabled?"Re-enabled from Platform Control":"Service disabled from Platform Control");await db.batch([
 db.prepare("UPDATE service_controls SET enabled=?,disabled_reason=?,updated_by=?,updated_at=? WHERE service_code=?").bind(input.enabled?1:0,input.enabled?null:auditReason,input.actorEmail,now,input.serviceCode),
 db.prepare("INSERT INTO service_control_audit_events (id,service_code,from_enabled,to_enabled,reason,actor_email,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.serviceCode,fromEnabled?1:0,input.enabled?1:0,auditReason,input.actorEmail,now),
]);return{code:definition.code,name:definition.name,group:definition.group,enabled:input.enabled,disabledReason:input.enabled?null:auditReason,updatedBy:input.actorEmail,updatedAt:now} satisfies ServiceControl}
async function existingSchedulingRequest(db:D1Database,groupId:string){if(!groupId)return false;try{return Boolean(await db.prepare("SELECT group_id FROM scheduling_assignment_decisions WHERE group_id=? LIMIT 1").bind(groupId).first())}catch{return false}}
async function existingFoodOrder(db:D1Database,idempotencyKey:string){if(!idempotencyKey)return false;try{return Boolean(await db.prepare("SELECT id FROM food_orders WHERE idempotency_key=? LIMIT 1").bind(idempotencyKey).first())}catch{return false}}
async function newCustomerService(request:Request,db:D1Database):Promise<PawSpaceServiceCode|null>{const url=new URL(request.url),method=request.method.toUpperCase();if(method!=="POST")return null;const commercial=commercialRequestPaths[url.pathname];if(commercial)return commercial;const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;
 if(url.pathname==="/api/uat-scheduling"){const action=String(body.action||"reserve");if(action!=="reserve")return null;const groupId=String(body.clientRequestId||"");if(await existingSchedulingRequest(db,groupId))return null;return schedulingMap[String(body.serviceCode||"")]??null}
 if(url.pathname==="/api/food-orders"){if(await existingFoodOrder(db,String(body.idempotencyKey||"")))return null;return"food"}
 if(url.pathname==="/api/food-subscriptions"&&String(body.action||"")==="create")return"food";
 if(url.pathname==="/api/relocation"&&String(body.action||"create")==="create")return"relocation";
 if(url.pathname==="/api/funeral-memorial"&&String(body.action||"create")==="create")return"funeral_memorial";
 return null}
export async function blockDisabledServiceRequest(request:Request,db:D1Database):Promise<Response|null>{const code=await newCustomerService(request,db);if(!code)return null;const services=await listServiceControls(db),service=services.find(item=>item.code===code);if(!service||service.enabled)return null;return Response.json({error:"SERVICE_DISABLED",serviceCode:service.code,serviceName:service.name,message:`${service.name} is temporarily unavailable for new customer requests.`,reason:service.disabledReason},{status:503,headers:{"cache-control":"no-store"}})}
