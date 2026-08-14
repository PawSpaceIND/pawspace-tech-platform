import { defaultRoles, hasPermission, type Permission } from "./platform-security";
import { resolveUatStaffActor, signInRequiredResponse, uatLoginEnabled } from "./uat-staging-auth";
import { resolvePlatformSession } from "./platform-session";

type GatewayEnv={DB:D1Database;FOUNDER_EMAIL?:string};
export type GatewayActor={email:string;roleCode:string;permissions:string[];preview:boolean};

async function ensureGatewayTables(env:GatewayEnv){const now=Date.now();await env.DB.batch([
  env.DB.prepare("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
  env.DB.prepare("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)"),
]);for(const role of defaultRoles)await env.DB.prepare("INSERT OR IGNORE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)").bind(role.code,role.name,role.description,JSON.stringify(role.permissions),1,now).run();}

async function requiredPermission(request:Request):Promise<Permission|null>{const url=new URL(request.url),method=request.method.toUpperCase();if(url.pathname==="/api/pricing-quote"||url.pathname==="/api/training-commercial"||url.pathname==="/api/training-trainers"||url.pathname==="/api/boarding-commercial"||url.pathname==="/api/sitting-commercial"||url.pathname==="/api/taxi-commercial"||url.pathname==="/api/food-commercial"||url.pathname==="/api/walking-commercial"||url.pathname==="/api/razorpay-webhook"||url.pathname==="/api/haptik"||url.pathname==="/api/whatsapp-uat-webhook"||url.pathname==="/api/identity-session"||url.pathname==="/api/service-availability"||url.pathname==="/api/public-contact"||url.pathname==="/api/provider-public-profile"||url.pathname==="/api/staging-login"
    ||url.pathname==="/api/customer-offers"||url.pathname==="/api/host-profile"||url.pathname==="/api/customer-otp"||url.pathname==="/api/partner-otp"||url.pathname==="/api/customer-profile"||url.pathname==="/api/customer-account"||url.pathname==="/api/booking-rating"||url.pathname==="/api/customer-support-case"||url.pathname==="/api/live-price-quote"||url.pathname==="/api/service-zone")return null;
  // D3/D4 remediation: these were fully public (all methods -> null), which let anyone write to the DB
  // unauthenticated. The catalog/trust READ stays public, but every WRITE now requires a real staff
  // permission so the handler can derive a server-side identity instead of a hardcoded 'founder_uat'.
  if(url.pathname==="/api/training-requirements")return method==="GET"?null:"pricing.manage";
  if(url.pathname==="/api/host-trust")return method==="GET"?null:"providers.manage";
  if(url.pathname==="/api/relocation-enquiry")return method==="POST"?null:"customers.view";
  if(url.pathname==="/api/content-controls"){if(method==="GET")return url.searchParams.get("view")==="admin"?"marketing.manage":null;const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action||"")==="set_feature"?"settings.manage":"marketing.manage";}
  if(url.pathname==="/api/operations-overview")return "dashboard.view";
  if(url.pathname==="/api/control-tower")return "audit.view";
  if(url.pathname==="/api/stay-balance")return "scheduling.book";
  if(url.pathname==="/api/partner-job-feed")return "bookings.view";
  if(url.pathname==="/api/provider-lms"){if(method==="GET")return "bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action||"")==="complete_module"?"bookings.view":"settings.manage";}
  if(url.pathname==="/api/me"||url.pathname==="/api/leaderboard"||url.pathname==="/api/provider-workspace")return "self_service.view";
  if(url.pathname==="/api/provider-commercial-terms")return method==="GET"?"finance.view":"finance.manage";
  if(url.pathname==="/api/funeral-manual-order")return method==="GET"?"finance.view":"finance.manage";
  if(url.pathname==="/api/platform-governance"){if(method==="GET")return "dashboard.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return body.action==="save_role"?"roles.manage":"users.manage";}
  if(url.pathname==="/api/identity-bindings")return "users.manage";
  if(url.pathname==="/api/communications"){if(method==="GET")return "communications.message";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"enqueue");if(action==="adapter_readiness"||action==="policy_update")return "settings.manage";if(action==="preference")return "customers.manage";return "communications.message";}
  if(url.pathname==="/api/conversations")return "communications.message";
  if(url.pathname==="/api/bot-call-outcomes"){if(method==="GET")return "customers.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action||"record")==="reconcile"?"customers.manage":"communications.call";}
  if(url.pathname==="/api/customer-contact"){const body=method==="POST"?await request.clone().json().catch(()=>({})) as Record<string,unknown>:{};return String(body.channel||"call")==="message"?"communications.message":"communications.call";}
  if(url.pathname==="/api/subscription-customers")return method==="GET"?"customers.view":"data.import";
  if(url.pathname==="/api/subscription-wallet"){if(method==="GET")return url.searchParams.get("customerId")?"customers.view":"scheduling.book";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["reserve","pause","resume"].includes(String(body.action))?"scheduling.book":"bookings.manage";}
  if(url.pathname==="/api/crm")return method==="GET"?"customers.view":"customers.manage";
  if(url.pathname==="/api/customer-360")return method==="GET"?"customers.view":"customers.manage";
  if(url.pathname==="/api/revenue-crm")return method==="GET"?"customers.view":"customers.manage";
  if(url.pathname==="/api/revenue-intelligence")return method==="GET"?"customers.view":"customers.manage";
  if(url.pathname==="/api/revenue-mission-control")return method==="GET"?"reports.view":"customers.manage";
  if(url.pathname==="/api/lead-assignment-governance"){if(method==="GET")return "customers.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action||"")==="accept_assignment"?"customers.view":"customers.manage";}
  if(url.pathname==="/api/lead-sla-governance"){if(method==="GET")return "customers.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action||"")==="record_action"?"customers.view":"customers.manage";}
  if(url.pathname==="/api/revenue-opportunity-governance")return method==="GET"?"customers.view":"customers.manage";
  if(url.pathname==="/api/sales-productivity-governance")return method==="GET"?"reports.view":"customers.manage";
  if(url.pathname==="/api/revenue-mission-command-center")return "reports.view";
  if(url.pathname==="/api/revenue-leadership-reporting")return method==="GET"?"reports.view":"customers.manage";
  if(url.pathname==="/api/prelaunch-booking-swarm")return method==="GET"?"launch.view":"launch.manage";
  if(url.pathname==="/api/crm-automation"){if(method==="GET")return "customers.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return body.action==="save_policy"?"settings.manage":"customers.manage";}
  if(url.pathname==="/api/unified-cases")return "bookings.manage";
  // Sweeping raises alerts platform-wide and stays a manager action. Acknowledge/resolve only needs
  // identity here: authority over an individual alert belongs to the team that owns it and is decided
  // per alert in lib/staff-alert-authority.ts. Gating them on customers.manage locked Finance out of
  // its own payment-failure alerts while letting any Manager close them.
  if(url.pathname==="/api/staff-alerts"){if(method==="GET")return "reports.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return body.action==="sweep"?"customers.manage":"reports.view";}
  if(url.pathname==="/api/staff-alert-runner")return "settings.manage";
  if(url.pathname==="/api/finance-control")return method==="GET"?"finance.view":"finance.manage";
  if(url.pathname==="/api/statutory-compliance")return method==="GET"?"finance.view":"finance.manage";
  if(url.pathname==="/api/pnl-reporting")return "finance.view";
  if(url.pathname==="/api/partner-finance")return method==="GET"?"finance.view":"finance.manage";
  if(url.pathname==="/api/company-analytics")return "reports.view";
  if(url.pathname==="/api/unit-economics")return "reports.view";
  if(url.pathname==="/api/ai-intelligence")return method==="GET"?"reports.view":"customers.manage";
  if(url.pathname==="/api/training-finance")return method==="GET"?"finance.view":"finance.manage";
  if(url.pathname==="/api/training-cancellation"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request"?"scheduling.book":"finance.manage";}
  if(url.pathname==="/api/training-customer-session-change")return "scheduling.book";
  if(url.pathname==="/api/training-ops")return "bookings.manage";
  if(url.pathname==="/api/training-provider-earnings")return "bookings.view";
  if(url.pathname==="/api/training-reconciliation")return "reports.view";
  if(url.pathname==="/api/marketing-control")return method==="GET"?"marketing.view":"marketing.manage";
  if(url.pathname==="/api/pricing-control")return method==="GET"?"pricing.view":"pricing.manage";
  if(url.pathname==="/api/coupon-governance"){if(method==="GET")return "pricing.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="quote")return "scheduling.book";if(action==="save_campaign")return "pricing.manage";if(action==="consume")return "bookings.manage";return "dashboard.view";}
  if(url.pathname==="/api/grooming-subscription-plans")return method==="GET"?"pricing.view":"pricing.manage";
  if(url.pathname==="/api/grooming-commercial-policy")return method==="GET"?"pricing.view":"pricing.manage";
  if(url.pathname==="/api/provider-capacity-control")return method==="GET"?"scheduling.view":"scheduling.manage";
  if(url.pathname==="/api/provider-assignment-recovery"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["accept","decline"].includes(String(body.action))?"bookings.view":"bookings.manage";}
  if(url.pathname==="/api/assisted-orders")return "scheduling.book";
  if(url.pathname==="/api/walking-bookings")return "scheduling.book";
  if(url.pathname==="/api/walking-lifecycle"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");return action==="no_show"?"bookings.manage":"bookings.view";}
  if(url.pathname==="/api/walking-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");return action==="request_cancel"?"scheduling.book":"finance.manage";}
  if(url.pathname==="/api/walking-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="acknowledge_incident")return "scheduling.book";if(["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(action))return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/walking-ops")return "bookings.manage";
  if(url.pathname==="/api/walking-recovery")return "bookings.view";
  if(url.pathname==="/api/taxi-bookings")return "scheduling.book";
  if(url.pathname==="/api/taxi-lifecycle"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="no_show"?"bookings.manage":"bookings.view";}
  if(url.pathname==="/api/taxi-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request_cancel"?"scheduling.book":"finance.manage";}
  if(url.pathname==="/api/taxi-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="acknowledge_incident")return "scheduling.book";if(["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(action))return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/taxi-ops")return "bookings.manage";
  if(url.pathname==="/api/taxi-recovery")return "bookings.view";
  if(url.pathname==="/api/food-orders")return "scheduling.book";
  if(url.pathname==="/api/food-subscriptions"){if(method==="GET")return "scheduling.book";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");return ["process_due","record_payment"].includes(action)?"finance.manage":"scheduling.book";}
  if(url.pathname==="/api/food-fulfilment"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";return "bookings.manage";}
  if(url.pathname==="/api/food-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request_cancel"?"scheduling.book":"finance.manage";}
  if(url.pathname==="/api/food-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");return action==="acknowledge_incident"?"scheduling.book":"bookings.manage";}
  if(url.pathname==="/api/food-ops")return "bookings.manage";
  if(url.pathname==="/api/food-supply-chain")return "bookings.manage";
  if(url.pathname==="/api/relocation"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"create");if(["create","register_document","accept_quote","request_refund","open_support"].includes(action))return "scheduling.book";if(["record_payment","resolve_refund"].includes(action))return "finance.manage";return "bookings.manage";}
  if(url.pathname==="/api/funeral-memorial"){if(method==="GET"){if(url.searchParams.get("config")==="1")return "pricing.view";if(url.searchParams.get("report")==="summary")return "reports.view";return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";}const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"create");if(action==="save_service_config")return "pricing.manage";if(["create","register_customer_media","schedule_ash_collection","request_refund","open_support"].includes(action))return "scheduling.book";if(["set_service_amount","record_payment","resolve_refund"].includes(action))return "finance.manage";return "bookings.manage";}
  if(url.pathname==="/api/sitting-payment-sandbox"||url.pathname==="/api/sitting-bookings")return "scheduling.book";
  if(url.pathname==="/api/sitting-lifecycle"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="submit_care_plan")return "scheduling.book";if(action==="no_show")return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/sitting-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");return ["request_cancel","request_date_change"].includes(action)?"scheduling.book":"finance.manage";}
  if(url.pathname==="/api/sitting-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="acknowledge_incident")return "scheduling.book";if(["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(action))return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/sitting-ops")return "bookings.manage";
  if(url.pathname==="/api/boarding-stays"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(["submit_care_plan","request_extension"].includes(action))return "scheduling.book";if(action==="no_show")return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/boarding-finance"){if(method==="GET")return "finance.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");return ["request_cancel","request_date_change"].includes(action)?"scheduling.book":"finance.manage";}
  if(url.pathname==="/api/boarding-proof"){if(method==="GET")return url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="acknowledge_incident")return "scheduling.book";if(["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(action))return "bookings.manage";return "bookings.view";}
  if(url.pathname==="/api/boarding-ops")return "bookings.manage";
  if(url.pathname==="/api/scheduling-rules")return method==="GET"?"scheduling.view":"scheduling.manage";
  if(url.pathname==="/api/launch-readiness")return method==="GET"?"launch.view":"launch.manage";
  if(url.pathname==="/api/city-governance")return method==="GET"?"launch.view":"launch.manage";
  if(url.pathname==="/api/integration-readiness")return method==="GET"?"launch.view":"launch.manage";
  if(url.pathname==="/api/uat-scheduling"){if(method==="GET")return "scheduling.manage";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return body.action&&body.action!=="reserve"?"scheduling.manage":"scheduling.book";}
  if(url.pathname==="/api/canonical-bookings")return method==="GET"?"bookings.manage":"scheduling.book";
  if(url.pathname==="/api/referral-governance"){if(method==="GET")return "pricing.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"");if(action==="save_programme")return "pricing.manage";if(["qualify","review"].includes(action))return "bookings.manage";if(action==="reverse_reward")return "finance.manage";return "scheduling.book";}
  if(url.pathname==="/api/training-programmes")return "scheduling.book";
  if(url.pathname==="/api/training-session-media")return "bookings.view";
  if(url.pathname==="/api/training-sessions"){if(method==="GET")return "bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["reschedule","replace_provider","cancel_session"].includes(String(body.action))?"bookings.manage":"bookings.view";}
  if(url.pathname==="/api/grooming-service-location")return "scheduling.book";
  if(url.pathname==="/api/address-autocomplete")return "scheduling.book";
  if(url.pathname==="/api/grooming-route")return "bookings.view";
  if(url.pathname==="/api/booking-command-center")return "bookings.manage";
  if(url.pathname==="/api/ops-work-queue")return "bookings.manage";
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
  // Reporting what happened on a job is a communications act; changing what the customer owes is not.
  // `package_upgrade` only records a request now - the money moves through `apply_package_upgrade`,
  // which is a pricing decision. The route enforces the same mapping itself, so a path the gateway
  // does not recognise cannot get a weaker answer than this one.
  if(url.pathname==="/api/booking-operations"){if(method==="GET")return "bookings.view";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;if(body.action==="refund_status")return "payments.manage";if(body.action==="apply_package_upgrade")return "pricing.manage";return ["package_upgrade","service_overrun","running_late","vehicle_issue","rebook_requested","refund_requested"].includes(String(body.action))?"communications.message":"bookings.manage";}
  if(url.pathname==="/api/meet-and-greet")return method==="POST"?null:"bookings.manage";
  return "dashboard.view";
}

async function audit(env:GatewayEnv,actor:GatewayActor,request:Request,outcome:string,detail:unknown){await env.DB.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),actor.email,actor.roleCode,request.method,new URL(request.url).pathname,null,outcome,JSON.stringify(detail),Date.now()).run();}

export async function authorizeApiRequest(request:Request,env:GatewayEnv):Promise<{actor:GatewayActor;permission:Permission|null}|Response>{const url=new URL(request.url);if(!url.pathname.startsWith("/api/"))return {actor:{email:"",roleCode:"public",permissions:[],preview:false},permission:null};const permission=await requiredPermission(request);if(permission===null)return {actor:{email:"",roleCode:"public",permissions:[],preview:false},permission:null};
  if(!["GET","HEAD","OPTIONS"].includes(request.method)){const origin=request.headers.get("origin");if(origin&&origin!==url.origin)return Response.json({error:"Cross-origin write blocked"},{status:403});}
  if(["terminal.local","localhost","127.0.0.1"].includes(url.hostname))return {actor:{email:"preview@pawspace.test",roleCode:"superuser",permissions:["*"],preview:true},permission};
  // Staging-only UAT sign-in: honour the signed UAT cookie when enabled (a no-op in production, where
  // PAWSPACE_UAT_LOGIN is unset, so this falls straight through to the real header-based identity check).
  const uat=await resolveUatStaffActor(env.DB,request,env as unknown as Record<string,unknown>);
  if(uat){const actor={email:uat.email,roleCode:uat.roleCode,permissions:uat.permissions,preview:false};if(!hasPermission(uat.permissions,permission)){await audit(env,actor,request,"denied",{permission});return Response.json({error:"Permission denied"},{status:403});}return {actor,permission};}
  // Customer/provider OTP identities hold a platform session cookie, not a staff header identity.
  // Without this check the gateway 401s them on gated self-service endpoints (e.g. GET
  // /api/boarding-stays?scope=customer) even though the route's own resolveActor supports the
  // session; per-record ownership is still enforced by the route via requireCustomerOwnership/
  // requireProviderOwnership - the gateway only maps the session to its limited role permissions.
  const session=await resolvePlatformSession(env.DB,request).catch(()=>null);
  if(session){const actor={email:session.auditId,roleCode:session.roleCode,permissions:session.permissions,preview:false};if(!hasPermission(session.permissions,permission)){await audit(env,actor,request,"denied",{permission});return Response.json({error:"Permission denied"},{status:403});}return {actor,permission};}
  const email=(request.headers.get("oai-authenticated-user-email")||"").trim().toLowerCase();if(!email)return uatLoginEnabled(env as unknown as Record<string,unknown>)?signInRequiredResponse(env as unknown as Record<string,unknown>):Response.json({error:"Authentication required"},{status:401});await ensureGatewayTables(env);
  let user=await env.DB.prepare("SELECT name,role_code,status FROM app_users WHERE email=?").bind(email).first<Record<string,unknown>>();if(!user&&email===String(env.FOUNDER_EMAIL||"").trim().toLowerCase()){const now=Date.now();await env.DB.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),email,email.split("@")[0],"founder","active",now,now).run();user={role_code:"founder",status:"active"};}
  if(!user||user.status!=="active")return Response.json({error:"Access has not been provisioned or is disabled"},{status:403});const role=await env.DB.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").bind(String(user.role_code)).first<{permissions_json:string}>();let permissions:string[]=[];try{permissions=JSON.parse(role?.permissions_json||"[]") as string[]}catch{}
  const actor={email,roleCode:String(user.role_code),permissions,preview:false};if(!hasPermission(permissions,permission)){await audit(env,actor,request,"denied",{permission});return Response.json({error:"Permission denied"},{status:403});}return {actor,permission};}

export async function auditApiResponse(env:GatewayEnv,actor:GatewayActor,permission:Permission|null,request:Request,response:Response){if(!permission||actor.roleCode==="public")return;await audit(env,actor,request,response.ok?"allowed":"failed",{permission,status:response.status});}
