import{hasPermission,type Permission}from"./platform-security";
import{resolvePlatformSession,type PlatformSessionActor}from"./platform-session";

type SessionAccess={actor:{email:string;roleCode:string;permissions:string[];preview:boolean};permission:Permission};
type Scope={permission:Permission;subjectType:"customer"|"provider";subjectId?:string};

export async function sessionScope(request:Request):Promise<Scope|undefined>{const url=new URL(request.url),method=request.method.toUpperCase();
  if(url.pathname==="/api/customer-checkout"&&method==="POST")return{permission:"scheduling.book",subjectType:"customer"};
  if(url.pathname==="/api/provider-onboarding-self-service"&&["GET","POST"].includes(method))return{permission:"bookings.view",subjectType:"provider"};
  if(url.pathname==="/api/provider-chat"&&method==="GET")return{permission:"communications.message",subjectType:"provider",subjectId:String(url.searchParams.get("providerId")||"")};
  if(url.pathname==="/api/provider-chat"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return{permission:"communications.message",subjectType:"provider",subjectId:String(body.providerId||"")};}
  if(url.pathname==="/api/provider-safety-flag"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return{permission:"communications.message",subjectType:"provider",subjectId:String(body.providerId||"")};}
  if(url.pathname==="/api/ai-web-chat"&&method==="POST")return{permission:"scheduling.book",subjectType:"customer"};
  if(url.pathname==="/api/uat-scheduling"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return !body.action||body.action==="reserve"?{permission:"scheduling.book",subjectType:"customer",subjectId:String(body.customerId||"")}:undefined;}
  if(url.pathname==="/api/canonical-bookings"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as {customer?:{id?:string}};return{permission:"scheduling.book",subjectType:"customer",subjectId:String(body.customer?.id||"")};}
  if(url.pathname==="/api/training-programmes"&&["GET","POST"].includes(method))return{permission:"scheduling.book",subjectType:"customer"};
  if(url.pathname==="/api/training-cancellation"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request"?{permission:"scheduling.book",subjectType:"customer"}:undefined;}
  if(url.pathname==="/api/training-customer-session-change"&&method==="POST")return{permission:"scheduling.book",subjectType:"customer"};
  if(url.pathname==="/api/training-provider-earnings"&&method==="GET")return{permission:"bookings.view",subjectType:"provider",subjectId:String(url.searchParams.get("providerId")||"")};
  if(url.pathname==="/api/training-sessions"&&method==="GET")return{permission:"bookings.view",subjectType:"provider",subjectId:String(url.searchParams.get("providerId")||"")};
  if(url.pathname==="/api/training-sessions"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["reschedule","replace_provider","cancel_session"].includes(String(body.action))?undefined:{permission:"bookings.view",subjectType:"provider"};}
  if(url.pathname==="/api/training-session-media"&&["GET","POST"].includes(method))return{permission:"bookings.view",subjectType:"provider"};
  if(url.pathname==="/api/grooming-service-location"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return{permission:"scheduling.book",subjectType:"customer",subjectId:String(body.customerId||"")};}
  if(url.pathname==="/api/customer-grooming-summary"&&method==="GET")return{permission:"scheduling.book",subjectType:"customer"};
  if(url.pathname==="/api/grooming-booking-change"&&method==="GET")return{permission:"scheduling.book",subjectType:"customer"};
  // The route performs authoritative booking/customer ownership checks itself. Do not consume a
  // cloned browser request body here: on streamed browser POSTs this can stall the downstream body
  // reader before the route can answer. Session auth still requires a customer with scheduling.book.
  if(url.pathname==="/api/grooming-booking-change"&&method==="POST")return{permission:"scheduling.book",subjectType:"customer"};
  if(url.pathname==="/api/partner-grooming-jobs"&&method==="GET")return{permission:"bookings.view",subjectType:"provider",subjectId:String(url.searchParams.get("providerId")||"")};
  if(url.pathname==="/api/grooming-route"&&method==="GET")return{permission:"bookings.view",subjectType:"provider",subjectId:String(url.searchParams.get("providerId")||"")};
  if((url.pathname==="/api/grooming-route"||url.pathname==="/api/partner-heartbeat")&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return{permission:"bookings.view",subjectType:"provider",subjectId:String(body.providerId||"")};}
  if(url.pathname==="/api/grooming-lifecycle"){if(method==="GET")return{permission:"bookings.view",subjectType:"provider"};if(method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return body.action==="mark_paid"?undefined:{permission:"bookings.view",subjectType:"provider"};}}
  if(url.pathname==="/api/provider-assignment-recovery"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["accept","decline"].includes(String(body.action))?{permission:"bookings.view",subjectType:"provider",subjectId:String(body.providerId||"")}:undefined;}
  /* These three are provider-facing routes that were never registered here, so every provider request
   * fell through to the staff gateway, whose unenumerated catch-all resolves "dashboard.view" - a
   * permission the service_provider role does not hold. The handlers were written for providers and
   * do their own ownership checks; they were simply unreachable. Symptoms: /partner/rates could not
   * load or save a provider's own pricing, the job list was empty on /partner-app, /partner-mobile
   * and /groomer, and a partner could never request payment after a service.
   *
   * /api/partner-jobs re-exports its handler from /api/partner-grooming-jobs, which IS registered
   * three lines below and works - the same code, reachable through one path and not the other. */
  if(url.pathname==="/api/partner-jobs"&&method==="GET")return{permission:"bookings.view",subjectType:"provider",subjectId:String(url.searchParams.get("providerId")||"")};
  if(url.pathname==="/api/provider-service-rates"&&["GET","POST"].includes(method))return{permission:"self_service.view",subjectType:"provider"};
  /* Only the provider-initiated action is session-scoped. create_order, initiate_refund, link_order
   * and simulate_event stay staff-only and keep falling through to the staff gateway's payments.manage. */
  if(url.pathname==="/api/grooming-payment-sandbox"&&method==="GET")return{permission:"bookings.view",subjectType:"provider"};
  if(url.pathname==="/api/grooming-payment-sandbox"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request_after_service"?{permission:"bookings.view",subjectType:"provider"}:undefined;}
 /* Funeral coordination is provider-facing: app/partner/funeral reads its own queue and completes
  * milestones. Without these the STAFF gateway answers first and maps the coordinator actions to
  * bookings.manage, which service_provider does not hold - a silent 403 on the partner's own screen.
  * The route still binds the subject itself (requireFuneralCoordinator + requireProviderOwnership), so
  * this only stops the staff gateway from refusing before the route is reached. [PTJA-FUNERAL-SCOPE] */
 if(url.pathname==="/api/funeral-memorial"&&method==="GET"&&url.searchParams.get("scope")==="provider")return{permission:"bookings.view",subjectType:"provider"};
 if(url.pathname==="/api/funeral-memorial"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["coordinate_pickup","complete_milestone","register_media","update_ash_collection","close_case"].includes(String(body.action||""))?{permission:"bookings.view",subjectType:"provider"}:undefined;}
  return undefined;
}

function subjectAllowed(session:PlatformSessionActor,scope:Scope){if(session.subjectType!==scope.subjectType)return false;if(scope.subjectId&&scope.subjectId!==session.subjectId)return false;return true;}

export async function authorizePlatformSessionRequest(request:Request,db:D1Database):Promise<SessionAccess|Response|null>{const session=await resolvePlatformSession(db,request);if(!session)return null;const scope=await sessionScope(request);if(!scope)return null;if(!["GET","HEAD","OPTIONS"].includes(request.method)){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Cross-origin write blocked"},{status:403});}if(!subjectAllowed(session,scope))return Response.json({error:"Identity session does not own this customer/provider scope"},{status:403});if(!hasPermission(session.permissions,scope.permission))return Response.json({error:"Permission denied"},{status:403});return{actor:{email:session.auditId,roleCode:session.roleCode,permissions:session.permissions,preview:false},permission:scope.permission};}
