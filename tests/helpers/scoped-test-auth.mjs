/**
 * Test-only authorization fixture.
 *
 * Historical functional suites relied on PAWSPACE_LOCAL_PREVIEW=on, which made every localhost
 * request a ["*"] superuser. This helper replaces that blind spot with real app_users + custom
 * one-purpose roles. The route contract below is intentionally duplicated from the expected RBAC
 * policy rather than imported from production: if production changes a route's permission, the
 * fixture does NOT silently follow it and the test fails.
 *
 * Only localhost/terminal.local requests with no explicit identity/session are decorated. Tests that
 * use a non-local origin, an explicit identity, or x-pawspace-test-anonymous=1 continue to exercise
 * anonymous/denied paths exactly as written.
 */

const LOCAL_HOSTS=new Set(["localhost","127.0.0.1","terminal.local"]);
const PUBLIC=new Set([
  "/api/pricing-quote","/api/training-commercial","/api/training-trainers","/api/boarding-commercial","/api/sitting-commercial","/api/taxi-commercial","/api/food-commercial","/api/walking-commercial","/api/razorpay-webhook","/api/voice-provider-webhook","/api/webhooks/exotel/call-event","/api/provider-verification-callback","/api/communication-provider-callback","/api/haptik","/api/whatsapp-uat-webhook","/api/whatsapp/meta-webhook","/api/email-provider-webhook","/api/identity-session","/api/service-availability","/api/public-contact","/api/inquiries","/api/provider-public-profile","/api/staging-login","/api/partner-otp","/api/pet-passport-public","/api/host-profile","/api/customer-otp","/api/customer-profile","/api/customer-account","/api/booking-rating","/api/customer-support-case","/api/live-price-quote","/api/training-requirements","/api/host-trust","/api/service-zone","/api/meet-and-greet","/api/uat-provider-switch","/api/communications/voice/bridge"
]);

const SIMPLE=new Map(Object.entries({
  "/api/customer-offers":"scheduling.book","/api/payment-order":"scheduling.book","/api/pet-passport":"scheduling.book","/api/pet-vaccination":"scheduling.book","/api/pet-birthday":"scheduling.book","/api/pet-emergency":"scheduling.book","/api/provider-availability":"bookings.view","/api/operations-overview":"dashboard.view","/api/control-tower":"audit.view","/api/stay-balance":"scheduling.book","/api/partner-job-feed":"bookings.view","/api/me":"self_service.view","/api/leaderboard":"self_service.view","/api/provider-workspace":"self_service.view","/api/identity-bindings":"users.manage","/api/conversations":"communications.manage","/api/ai-human-handoff":"communications.manage","/api/voice-outbound":"customers.manage","/api/ai-voice-uat":"communications.call","/api/voice-speech":"communications.call","/api/voice-providers":"settings.manage","/api/bot-call-outcomes":"customers.manage","/api/customer-contact":"communications.manage","/api/subscription-billing":"scheduling.book","/api/unified-cases":"bookings.manage","/api/staff-alert-runner":"settings.manage","/api/pnl-reporting":"finance.view","/api/company-analytics":"reports.view","/api/unit-economics":"reports.view","/api/training-payment-sandbox":"scheduling.book","/api/training-ops":"bookings.manage","/api/training-provider-earnings":"bookings.view","/api/training-reconciliation":"reports.view","/api/booking-cancellation-case":"bookings.view","/api/customer-data-reveal":"customers.view","/api/provider-capacity-control":"scheduling.manage","/api/assisted-orders":"scheduling.book","/api/walking-bookings":"scheduling.book","/api/walking-ops":"bookings.manage","/api/walking-recovery":"bookings.view","/api/taxi-bookings":"scheduling.book","/api/taxi-ops":"bookings.manage","/api/taxi-recovery":"bookings.view","/api/food-orders":"scheduling.book","/api/food-ops":"bookings.manage","/api/food-supply-chain":"bookings.manage","/api/sitting-payment-sandbox":"scheduling.book","/api/sitting-bookings":"scheduling.book","/api/sitting-ops":"bookings.manage","/api/boarding-ops":"bookings.manage","/api/canonical-bookings":"scheduling.book","/api/training-programmes":"scheduling.book","/api/training-session-media":"bookings.view","/api/grooming-service-location":"scheduling.book","/api/address-autocomplete":"scheduling.book","/api/grooming-route":"bookings.view","/api/booking-command-center":"bookings.manage","/api/ops-work-queue":"bookings.manage","/api/partner-grooming-jobs":"bookings.view","/api/service-media":"bookings.view","/api/grooming-booking-change":"scheduling.book","/api/grooming-finance":"finance.view","/api/grooming-payment-sandbox":"payments.manage","/api/pilot-api-readiness":"dashboard.view","/api/team-overview":"dashboard.view","/api/manager-dashboard":"dashboard.view","/api/reports":"reports.view","/api/payroll":"finance.view","/api/attendance":"self_service.view","/api/incentives":"self_service.view","/api/acquisition-funnel":"reports.view","/api/cash-flow":"finance.view","/api/finance-anomalies":"finance.view","/api/growth-intelligence":"reports.view","/api/ops-intelligence":"reports.view","/api/employee-self-service":"self_service.view"
}));

function bodyObject(init){
  const raw=init?.body;
  if(typeof raw!=="string")return{};
  try{return JSON.parse(raw)||{};}catch{return{};}
}
function methodOf(input,init){return String(init?.method||(input instanceof Request?input.method:"GET")||"GET").toUpperCase();}
function permissionFor(path,method,body,url){
  if(PUBLIC.has(path))return null;
  if(SIMPLE.has(path))return SIMPLE.get(path);
  if(path==="/api/pawspace-wallet")return method==="GET"?"scheduling.book":String(body.action||"")==="credit"?"finance.manage":"scheduling.book";
  if(path==="/api/paw-points")return method==="GET"?"scheduling.book":["grant_goodwill","grant_winback"].includes(String(body.action||""))?"marketing.manage":"scheduling.book";
  if(path==="/api/service-review")return method==="GET"?"scheduling.book":String(body.action||"")==="request"?"bookings.manage":String(body.action||"")==="verify_claim"?"marketing.manage":"scheduling.book";
  if(path==="/api/location-recovery")return method==="GET"?null:["start_session","record_location","calculate_eta"].includes(String(body.action||""))?"bookings.view":String(body.action||"")==="create_financial_adjustment"?"finance.manage":"bookings.manage";
  if(path==="/api/relocation-enquiry")return method==="POST"?null:"customers.view";
  if(path==="/api/content-controls")return method==="GET"?(url.searchParams.get("view")==="admin"?"marketing.manage":null):String(body.action||"")==="set_feature"?"settings.manage":"marketing.manage";
  if(path==="/api/provider-lms")return method==="GET"?"bookings.view":String(body.action||"")==="complete_module"?"bookings.view":"settings.manage";
  if(path==="/api/provider-commercial-terms"||path==="/api/funeral-manual-order")return method==="GET"?"finance.view":"finance.manage";
  if(path==="/api/platform-governance")return method==="GET"?"dashboard.view":body.action==="save_role"?"roles.manage":"users.manage";
  if(path==="/api/communications")return method==="GET"?"communications.manage":["adapter_readiness","policy_update"].includes(String(body.action||""))?"settings.manage":String(body.action||"")==="preference"?"customers.manage":"communications.manage";
  if(path==="/api/ai-web-chat")return method==="GET"?null:String(body.mode||"public")==="authenticated"?"scheduling.book":null;
  if(path==="/api/haptik-outbound")return method==="GET"?"marketing.view":"marketing.manage";
  if(path==="/api/subscription-customers")return method==="GET"?"customers.view":"data.import";
  if(path==="/api/subscription-wallet")return method==="GET"?(url.searchParams.get("customerId")?"customers.view":"scheduling.book"):["reserve","pause","resume"].includes(String(body.action||""))?"scheduling.book":"bookings.manage";
  if(path==="/api/subscription-billing-admin")return["save_plan","approve_plan"].includes(String(body.action||""))?"pricing.manage":"finance.manage";
  if(path==="/api/crm"||path==="/api/customer-360"||path==="/api/revenue-crm"||path==="/api/revenue-intelligence")return method==="GET"?"customers.view":"customers.manage";
  if(path==="/api/revenue-mission-control")return method==="GET"?"reports.view":"customers.manage";
  if(path==="/api/lead-assignment-governance"||path==="/api/lead-sla-governance")return method==="GET"?"customers.view":String(body.action||"").startsWith("accept")||String(body.action||"")==="record_action"?"customers.view":"customers.manage";
  if(path==="/api/revenue-opportunity-governance")return method==="GET"?"customers.view":"customers.manage";
  if(path==="/api/sales-productivity-governance")return method==="GET"?"reports.view":"customers.manage";
  if(path==="/api/revenue-mission-command-center"||path==="/api/revenue-leadership-reporting")return"reports.view";
  if(path==="/api/prelaunch-booking-swarm")return method==="GET"?"launch.view":"launch.manage";
  if(path==="/api/crm-automation")return method==="GET"?"customers.view":String(body.action||"")==="save_policy"?"settings.manage":"customers.manage";
  if(path==="/api/staff-alerts")return method==="GET"?"reports.view":String(body.action||"")==="sweep"?"customers.manage":"reports.view";
  if(path==="/api/finance-control"||path==="/api/statutory-compliance"||path==="/api/partner-finance"||path==="/api/training-finance")return method==="GET"?"finance.view":"finance.manage";
  if(path==="/api/ai-intelligence")return method==="GET"?"reports.view":"customers.manage";
  if(path==="/api/training-cancellation")return String(body.action||"")==="request"?"scheduling.book":"finance.manage";
  if(path==="/api/training-customer-session-change")return"scheduling.book";
  if(path==="/api/marketing-control")return method==="GET"?"marketing.view":"marketing.manage";
  if(path==="/api/pricing-control"||path==="/api/grooming-subscription-plans"||path==="/api/grooming-commercial-policy")return method==="GET"?"pricing.view":"pricing.manage";
  if(path==="/api/service-policy-control")return method==="GET"?"launch.view":"settings.manage";
  if(path==="/api/coupon-governance")return method==="GET"?"pricing.view":String(body.action||"")==="quote"?"scheduling.book":String(body.action||"")==="save_campaign"?"pricing.manage":String(body.action||"")==="consume"?"bookings.manage":"dashboard.view";
  if(path==="/api/provider-assignment-recovery")return["accept","decline"].includes(String(body.action||""))?"bookings.view":"bookings.manage";
  if(path==="/api/walking-lifecycle"||path==="/api/taxi-lifecycle"||path==="/api/sitting-lifecycle"||path==="/api/boarding-stays")return method==="GET"?(url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view"):String(body.action||"")==="no_show"?"bookings.manage":["submit_care_plan","request_extension"].includes(String(body.action||""))?"scheduling.book":"bookings.view";
  if(path==="/api/walking-finance"||path==="/api/taxi-finance"||path==="/api/food-finance"||path==="/api/sitting-finance"||path==="/api/boarding-finance")return method==="GET"?"finance.view":["request_cancel","request_date_change"].includes(String(body.action||""))?"scheduling.book":"finance.manage";
  if(path==="/api/walking-proof"||path==="/api/taxi-proof"||path==="/api/sitting-proof"||path==="/api/boarding-proof"||path==="/api/food-proof")return method==="GET"?(url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view"):String(body.action||"")==="acknowledge_incident"?"scheduling.book":["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"].includes(String(body.action||""))?"bookings.manage":"bookings.view";
  if(path==="/api/food-subscriptions")return method==="GET"?"scheduling.book":["process_due","record_payment"].includes(String(body.action||""))?"finance.manage":"scheduling.book";
  if(path==="/api/food-fulfilment")return method==="GET"?(url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view"):"bookings.manage";
  if(path==="/api/relocation"||path==="/api/funeral-memorial")return method==="GET"?(url.searchParams.get("scope")==="customer"?"scheduling.book":"bookings.view"):["create","register_document","register_customer_media","accept_quote","request_refund","open_support","schedule_ash_collection"].includes(String(body.action||"create"))?"scheduling.book":["record_payment","resolve_refund","set_service_amount"].includes(String(body.action||""))?"finance.manage":"bookings.manage";
  if(path==="/api/scheduling-rules")return method==="GET"?"scheduling.view":"scheduling.manage";
  if(path==="/api/launch-readiness"||path==="/api/city-governance"||path==="/api/integration-readiness")return method==="GET"?"launch.view":"launch.manage";
  if(path==="/api/uat-scheduling")return method==="GET"?"scheduling.manage":body.action&&body.action!=="reserve"?"scheduling.manage":"scheduling.book";
  if(path==="/api/referral-governance")return method==="GET"?"pricing.view":String(body.action||"")==="save_programme"?"pricing.manage":["qualify","review"].includes(String(body.action||""))?"bookings.manage":String(body.action||"")==="reverse_reward"?"finance.manage":"scheduling.book";
  if(path==="/api/training-sessions")return method==="GET"?"bookings.view":["reschedule","replace_provider","cancel_session"].includes(String(body.action||""))?"bookings.manage":"bookings.view";
  if(path==="/api/grooming-lifecycle")return method==="GET"?"bookings.view":String(body.action||"")==="mark_paid"?"payments.manage":"bookings.view";
  if(path==="/api/booking-operations")return method==="GET"?"bookings.view":String(body.action||"")==="refund_status"?"payments.manage":String(body.action||"")==="apply_package_upgrade"?"pricing.manage":["package_upgrade","service_overrun","running_late","vehicle_issue","rebook_requested","refund_requested"].includes(String(body.action||""))?"communications.message":"bookings.manage";
  return"dashboard.view";
}

const registry=new Map();
const wrapped=new WeakMap();
let nativeRequest=null;

function targetIds(body,url){
  const customerId=String(body.customerId||body.customer_id||url.searchParams.get("customerId")||url.searchParams.get("customer_id")||"").trim();
  const providerId=String(body.providerId||body.provider_id||url.searchParams.get("providerId")||url.searchParams.get("provider_id")||"").trim();
  return{customerId,providerId};
}
function actorEmail(permission,ids){
  const suffix=ids.customerId?`customer-${ids.customerId}`:ids.providerId?`provider-${ids.providerId}`:permission.replace(/[^a-z0-9]+/gi,"-");
  return`scoped-${suffix.toLowerCase().slice(0,80)}@pawspace.test`;
}

export function installScopedRequestActors(){
  if(globalThis.__PAWSPACE_SCOPED_REQUEST_ACTORS_INSTALLED__)return;
  globalThis.__PAWSPACE_SCOPED_REQUEST_ACTORS_INSTALLED__=true;
  nativeRequest=globalThis.Request;
  globalThis.Request=class PawSpaceScopedTestRequest extends nativeRequest{
    constructor(input,init={}){
      let url;
      try{url=new URL(typeof input==="string"||input instanceof URL?String(input):input.url);}catch{return super(input,init);}
      const headers=new Headers(init.headers||(input instanceof nativeRequest?input.headers:undefined));
      const explicit=headers.has("oai-authenticated-user-email")||headers.has("cookie")||headers.get("x-pawspace-test-anonymous")==="1";
      if(!explicit&&LOCAL_HOSTS.has(url.hostname)){
        const body=bodyObject(init),permission=permissionFor(url.pathname,methodOf(input,init),body,url);
        if(permission){
          const ids=targetIds(body,url),email=actorEmail(permission,ids);
          registry.set(email,{email,permission,...ids});
          headers.set("oai-authenticated-user-email",email);
          headers.set("oai-authenticated-user-full-name",encodeURIComponent("Scoped test actor"));
          headers.set("oai-authenticated-user-full-name-encoding","percent-encoded-utf-8");
        }
      }
      return super(input,{...init,headers});
    }
  };
}

async function seedRegisteredActors(db){
  if(!registry.size)return;
  const now=Date.now();
  for(const actor of registry.values()){
    const role=`test_${actor.permission.replace(/[^a-z0-9]+/gi,"_").slice(0,48)}`;
    try{
      await db.prepare("INSERT OR IGNORE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,0,?)").bind(role,`Test ${actor.permission}`,"Test-only least-privilege role",JSON.stringify([actor.permission]),now).run();
      await db.prepare("INSERT OR IGNORE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)").bind(`TEST-${actor.email}`,actor.email,"Scoped test actor",role,now,now).run();
      if(actor.customerId)await db.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").bind(actor.email,actor.customerId,now,now).run();
      if(actor.providerId)await db.prepare("INSERT OR REPLACE INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").bind(actor.email,actor.providerId,now,now).run();
    }catch(error){
      // Security tables may not exist yet. The ensureSecurityTables batch is wrapped below and will
      // invoke this again immediately after creating them.
      if(!/no such table/i.test(String(error?.message||error)))throw error;
    }
  }
}

export function wrapDbWithScopedActors(db){
  if(!db||typeof db!=="object")return db;
  if(wrapped.has(db))return wrapped.get(db);
  const proxy=new Proxy(db,{
    get(target,key,receiver){
      if(key==="batch")return async(statements)=>{const result=await target.batch(statements);await seedRegisteredActors(proxy);return result;};
      return Reflect.get(target,key,receiver);
    }
  });
  wrapped.set(db,proxy);wrapped.set(proxy,proxy);return proxy;
}
