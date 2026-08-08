import { defaultRoles, hasPermission, type Permission } from "./platform-security";

type GatewayEnv={DB:D1Database;FOUNDER_EMAIL?:string};
export type GatewayActor={email:string;roleCode:string;permissions:string[];preview:boolean};

async function ensureGatewayTables(env:GatewayEnv){const now=Date.now();await env.DB.batch([
  env.DB.prepare("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)"),
]);for(const role of defaultRoles)await env.DB.prepare("INSERT OR IGNORE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)").bind(role.code,role.name,role.description,JSON.stringify(role.permissions),1,now).run();}

async function requiredPermission(request:Request):Promise<Permission|null>{const url=new URL(request.url),method=request.method.toUpperCase();if(url.pathname==="/api/pricing-quote"||url.pathname==="/api/training-commercial"||url.pathname==="/api/training-trainers"||url.pathname==="/api/boarding-commercial"||url.pathname==="/api/sitting-commercial"||url.pathname==="/api/walking-commercial"||url.pathname==="/api/razorpay-webhook"||url.pathname==="/api/identity-session")return null;
  if(url.pathname==="/api/platform-governance"){if(method==="GET")return "dashboard.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return body.action==="save_role"?"roles.manage":"users.manage";}
  if(url.pathname==="/api/identity-bindings")return "users.manage";
  if(url.pathname==="/api/communications"){if(method==="GET")return "communications.message";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"enqueue");if(action==="adapter_readiness"||action==="policy_update")return "settings.manage";if(action==="preference")return "customers.manage";return "communications.message";}
  if(url.pathname==="/api/customer-contact"){const body=method==="POST"?await request.clone().json().catch(()=>({})) as Record<string,unknown>:{};return String(body.channel||"call")==="message"?"communications.message":"communications.call";}
  if(url.pathname==="/api/subscription-customers")return method==="GET"?"customers.view":"data.import";
  if(url.pathname==="/api/crm")return method==="GET"?"customers.view":"customers.manage";
  if(url.pathname==="/api/revenue-crm")return method==="GET"?"customers.view":"customers.manage";
  if(url.pathname==="/api/finance-control")return method==="GET"?"finance.view":"finance.manage";
  if(url.pathname==="/api/training-finance")return method==="GET"?"finance.view":"finance.manage";
  if(url.pathname==="/api/training-cancellation"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request"?"scheduling.book":"finance.manage";}
  if(url.pathname==="/api/training-customer-session-change")return "scheduling.book";
  if(url.pathname==="/api/training-ops")return "bookings.view";
  if(url.pathname==="/api/training-provider-earnings")return "bookings.view";
  if(url.pathname==="/api/training-reconciliation")return "reports.view";
  if(url.pathname==="/api/marketing-control")return method==="GET"?"marketing.view":"marketing.manage";
  if(url.pathname==="/api/pricing-control")return method==="GET"?"pricing.view":"pricing.manage";
  if(url.pathname==="/api/grooming-subscription-plans")return method==="GET"?"pricing.view":"pricing.manage";
  if(url.pathname==="/api/grooming-commercial-policy")return method==="GET"?"pricing.view":"pricing.manage";
  if(url.pathname==="/api/provider-capacity-control")return method==="GET"?"scheduling.view":"scheduling.manage";
  if(url.pathname==="/api/provider-assignment-recovery"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["accept","decline"].includes(String(body.action))?"bookings.view":"bookings.manage";}
  if(url.pathname==="/api/walking-payment-sandbox"||url.pathname==="/api/walking-scheduling"||url.pathname==="/api/walking-bookings")return "scheduling.book";
  if(url.pathname==="/api/walking-lifecycle"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="submit_handover")return "scheduling.book";if(action==="no_show")return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/sitting-payment-sandbox"||url.pathname==="/api/sitting-bookings")return "scheduling.book";
  if(url.pathname==="/api/sitting-lifecycle"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="submit_care_plan")return "scheduling.book";if(action==="no_show")return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/sitting-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");return ["request_cancel","request_date_change"].includes(action)?"scheduling.book":"finance.manage";}
  if(url.pathname==="/api/sitting-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="acknowledge_incident")return "scheduling.book";if(["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(action))return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/sitting-ops")return method==="GET"?"bookings.view":"bookings.manage";
  if(url.pathname==="/api/boarding-stays"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(["submit_care_plan","request_extension"].includes(action))return "scheduling.book";if(action==="no_show")return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/boarding-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");return ["request_cancel","request_date_change"].includes(action)?"scheduling.book":"finance.manage";}
  if(url.pathname==="/api/boarding-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="acknowledge_incident")return "scheduling.book";if(["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(action))return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/boarding-ops")return method==="GET"?"bookings.view":"bookings.manage";
  if(url.pathname==="/api/scheduling-rules")return method==="GET"?"scheduling.view":"scheduling.manage";
  if(url.pathname==="/api/launch-readiness")return method==="GET"?"launch.view":"launch.manage";
  if(url.pathname==="/api/uat-scheduling"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return body.action&&body.action!=="reserve"?"scheduling.manage":"scheduling.book";}
  if(url.pathname==="/api/canonical-bookings")return method==="GET"?"bookings.view":"scheduling.book";
  if(url.pathname==="/api/training-programmes")return "scheduling.book";
  if(url.pathname==="/api/training-session-media")return "bookings.view";
  if(url.pathname==="/api/training-sessions"){if(method==="GET")return "bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["reschedule","replace_provider","cancel_session"].includes(String(body.action))?"bookings.manage":"bookings.view";}
  if(url.pathname==="/api/grooming-service-location")return "scheduling.book";
  if(url.pathname==="/api/grooming-route")return "bookings.view";
  if(url.pathname==="/api/booking-command-center")return method==="GET"?"bookings.view":"bookings.manage";
  if(url.pathname==="/api/partner-grooming-jobs")return "bookings.view";
  if(url.pathname==="/api/service-media")return "bookings.view";
  if(url.pathname==="/api/grooming-booking-change")return "scheduling.book";
  if(url.pathname==="/api/grooming-finance")return "finance.view";
  if(url.pathname==="/api/grooming-payment-sandbox")return "payments.manage";
  if(url.pathname==="/api/grooming-lifecycle"){
    if(method==="GET")return "bookings.view";
    const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;
    return body.action==="mark_paid"?"payments.manage":"bookings.view";
  }
  if(url.pathname==="/api/booking-operations"){if(method==="GET")return "bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;if(body.action==="refund_status")return "payments.manage";return ["package_upgrade","service_overrun","running_late","vehicle_issue"].includes(String(body.action))?"communications.message":"bookings.manage";}
  return "dashboard.view";
}

async function audit(env:GatewayEnv,actor:GatewayActor,request:Request,outcome:string,detail:unknown){await env.DB.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),actor.email,actor.roleCode,request.method,new URL(request.url).pathname,null,outcome,JSON.stringify(detail),Date.now()).run();}

export async function authorizeApiRequest(request:Request,env:GatewayEnv):Promise<{actor:GatewayActor;permission:Permission|null}|Response>{const url=new URL(request.url);if(!url.pathname.startsWith("/api/"))return {actor:{email:"",roleCode:"public",permissions:[],preview:false},permission:null};const permission=await requiredPermission(request);if(permission===null)return {actor:{email:"",roleCode:"public",permissions:[],preview:false},permission:null};
  if(!["GET","HEAD","OPTIONS"].includes(request.method)){const origin=request.headers.get("origin");if(origin&&origin!==url.origin)return Response.json({error:"Cross-origin write blocked"},{status:403});}
  if(["terminal.local","localhost","127.0.0.1"].includes(url.hostname))return {actor:{email:"preview@pawspace.test",roleCode:"superuser",permissions:["*"],preview:true},permission};
  const email=(request.headers.get("oai-authenticated-user-email")||"").trim().toLowerCase();if(!email)return Response.json({error:"Authentication required"},{status:401});await ensureGatewayTables(env);
  let user=await env.DB.prepare("SELECT name,role_code,status FROM app_users WHERE email=?").bind(email).first<Record<string,unknown>>();if(!user&&email===String(env.FOUNDER_EMAIL||"").trim().toLowerCase()){const now=Date.now();await env.DB.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),email,email.split("@")[0],"founder","active",now,now).run();user={role_code:"founder",status:"active"};}
  if(!user||user.status!=="active")return Response.json({error:"Access has not been provisioned or is disabled"},{status:403});const role=await env.DB.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").bind(String(user.role_code)).first<{permissions_json:string}>();let permissions:string[]=[];try{permissions=JSON.parse(role?.permissions_json||"[]") as string[]}catch{}
  const actor={email,roleCode:String(user.role_code),permissions,preview:false};if(!hasPermission(permissions,permission)){await audit(env,actor,request,"denied",{permission});return Response.json({error:"Permission denied"},{status:403});}return {actor,permission};}

export async function auditApiResponse(env:GatewayEnv,actor:GatewayActor,permission:Permission|null,request:Request,response:Response){if(!permission||actor.roleCode==="public")return;await audit(env,actor,request,response.ok?"allowed":"failed",{permission,status:response.status});}