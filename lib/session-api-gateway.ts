import{hasPermission,type Permission}from"./platform-security";
import{resolvePlatformSession,type PlatformSessionActor}from"./platform-session";

type SessionAccess={actor:{email:string;roleCode:string;permissions:string[];preview:boolean};permission:Permission};
type Scope={permission:Permission;subjectType:"customer"|"provider";subjectId?:string};

async function sessionScope(request:Request):Promise<Scope|undefined>{const url=new URL(request.url),method=request.method.toUpperCase();
  if(url.pathname==="/api/provider-onboarding-self-service"&&["GET","POST"].includes(method))return{permission:"bookings.view",subjectType:"provider"};
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
  if(url.pathname==="/api/grooming-booking-change"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return{permission:"scheduling.book",subjectType:"customer",subjectId:String(body.customerId||"")};}
  if(url.pathname==="/api/partner-grooming-jobs"&&method==="GET")return{permission:"bookings.view",subjectType:"provider",subjectId:String(url.searchParams.get("providerId")||"")};
  if(url.pathname==="/api/grooming-route"&&method==="GET")return{permission:"bookings.view",subjectType:"provider",subjectId:String(url.searchParams.get("providerId")||"")};
  if(url.pathname==="/api/grooming-route"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return{permission:"bookings.view",subjectType:"provider",subjectId:String(body.providerId||"")};}
  if(url.pathname==="/api/grooming-lifecycle"){if(method==="GET")return{permission:"bookings.view",subjectType:"provider"};if(method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return body.action==="mark_paid"?undefined:{permission:"bookings.view",subjectType:"provider"};}}
  if(url.pathname==="/api/provider-assignment-recovery"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["accept","decline"].includes(String(body.action))?{permission:"bookings.view",subjectType:"provider",subjectId:String(body.providerId||"")}:undefined;}
  // A provider toggling their own availability from the partner app. The route enforces
  // requireProviderOwnership(body.providerId); the scope binds the session to that same provider.
  if(url.pathname==="/api/provider-availability"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return{permission:"bookings.view",subjectType:"provider",subjectId:String(body.providerId||"")};}
  // Customer self-service surfaces reached with a customer platform-session cookie. Each route enforces
  // requireCustomerOwnership on the specific record (via its ownedContext helper); the gateway only
  // confirms the caller is a customer session holding the customer role's scheduling.book. Without these
  // entries requiredPermission() falls to the dashboard.view default and every customer is 403'd in
  // production - the flows work on localhost only because authorizeApiRequest short-circuits localhost to
  // a preview superuser, which is why this was invisible in development.
  if(["/api/payment-order","/api/pawspace-wallet","/api/paw-points","/api/pet-passport","/api/pet-vaccination","/api/pet-emergency","/api/pet-birthday","/api/service-review"].includes(url.pathname))return{permission:"scheduling.book",subjectType:"customer"};
  return undefined;
}

function subjectAllowed(session:PlatformSessionActor,scope:Scope){if(session.subjectType!==scope.subjectType)return false;if(scope.subjectId&&scope.subjectId!==session.subjectId)return false;return true;}

export async function authorizePlatformSessionRequest(request:Request,db:D1Database):Promise<SessionAccess|Response|null>{const session=await resolvePlatformSession(db,request);if(!session)return null;const scope=await sessionScope(request);if(!scope)return null;if(!["GET","HEAD","OPTIONS"].includes(request.method)){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Cross-origin write blocked"},{status:403});}if(!subjectAllowed(session,scope))return Response.json({error:"Identity session does not own this customer/provider scope"},{status:403});if(!hasPermission(session.permissions,scope.permission))return Response.json({error:"Permission denied"},{status:403});return{actor:{email:session.auditId,roleCode:session.roleCode,permissions:session.permissions,preview:false},permission:scope.permission};}
