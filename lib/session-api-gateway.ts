import{hasPermission,type Permission}from"./platform-security";
import{resolvePlatformSession}from"./platform-session";

type SessionAccess={actor:{email:string;roleCode:string;permissions:string[];preview:boolean};permission:Permission};

async function sessionPermission(request:Request):Promise<Permission|undefined>{const url=new URL(request.url),method=request.method.toUpperCase();
  if(url.pathname==="/api/uat-scheduling"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return !body.action||body.action==="reserve"?"scheduling.book":undefined;}
  if(url.pathname==="/api/canonical-bookings"&&method==="POST")return "scheduling.book";
  if(url.pathname==="/api/grooming-service-location"&&method==="POST")return "scheduling.book";
  if(url.pathname==="/api/grooming-booking-change"&&method==="POST")return "scheduling.book";
  if(url.pathname==="/api/partner-grooming-jobs"&&method==="GET")return "bookings.view";
  if(url.pathname==="/api/grooming-route"&&["GET","POST"].includes(method))return "bookings.view";
  if(url.pathname==="/api/grooming-lifecycle"){if(method==="GET")return "bookings.view";if(method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return body.action==="mark_paid"?undefined:"bookings.view";}}
  if(url.pathname==="/api/provider-assignment-recovery"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return ["accept","decline"].includes(String(body.action))?"bookings.view":undefined;}
  return undefined;
}

export async function authorizePlatformSessionRequest(request:Request,db:D1Database):Promise<SessionAccess|Response|null>{const session=await resolvePlatformSession(db,request);if(!session)return null;const permission=await sessionPermission(request);if(!permission)return null;if(!["GET","HEAD","OPTIONS"].includes(request.method)){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Cross-origin write blocked"},{status:403});}if(!hasPermission(session.permissions,permission))return Response.json({error:"Permission denied"},{status:403});return{actor:{email:session.auditId,roleCode:session.roleCode,permissions:session.permissions,preview:false},permission};}
