import{authError,authFailure,database,requirePermission,resolveActor,securityAudit,type AuthenticatedActor}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{PostServiceFeedbackError,cancelFeedbackCall,feedbackCallEligibility,feedbackCallPolicyFromEnv,postServiceReviewInvitation,runPostServiceFeedbackCallSweep,scheduleFeedbackCall,syntheticDispatchPermitted,syntheticFeedbackCallPlacer}from"../../../lib/post-service-feedback-call";

/**
 * Post-service honest review links and consented feedback calls, for the customer who actually received
 * the completed service.
 *
 * The customer actions (GET, schedule_call, cancel_call) are bound to a verified, active CUSTOMER platform
 * session and nothing else. The shared ownership helper lets staff with customers.manage, bookings.manage
 * or a development preview act for any customer; that is right for operations screens and wrong here,
 * because a feedback call is placed on the customer's own consent and the row records who asked. So the
 * principal is the session subject, a supplied customerId must equal it, and a staff header, a provider
 * session or a preview host gets 401 rather than a customer's consent attributed to them.
 *
 * Links come only from the approved review configuration. Scheduling policy comes only from explicit
 * configuration (unset refuses). This route owns NO real call placer: the only dispatch it can run
 * injects the synthetic no-dial placer, needs the voice permissions on a real staff identity, and runs
 * only when the environment carries explicit non-production markers AND the dedicated switch is on.
 */
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(value:unknown)=>String(value??"").trim();
type Env=Record<string,unknown>;
const CUSTOMER_SIGN_IN_REQUIRED="A verified customer sign-in is required. Sign in and try again.";
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin feedback write blocked",{status:403});}
async function runtime():Promise<Env>{const{env}=await import("cloudflare:workers");return env as unknown as Env;}
function failure(error:unknown,fallback:string){if(error instanceof PostServiceFeedbackError)return json({error:error.message,code:error.code},error.status);return authError(error,fallback);}
function preferredAtMs(value:unknown){if(typeof value==="number")return value;const raw=text(value);if(!raw)return NaN;if(/^\d+$/.test(raw))return Number(raw);return Date.parse(raw);}

/**
 * The customer principal, from the platform session only. resolvePlatformSession already refuses a
 * revoked or expired session, an inactive or unverified binding, and a binding whose subject or
 * principal drifted from the session. Nothing here consults a staff header or the preview host.
 */
async function customerContext(request:Request,requestedCustomerId?:string){
  const db=await database();
  const session=await resolvePlatformSession(db,request);
  if(!session||session.subjectType!=="customer"||!text(session.subjectId))throw authFailure(CUSTOMER_SIGN_IN_REQUIRED,401);
  const customerId=text(session.subjectId);
  if(text(requestedCustomerId)&&text(requestedCustomerId)!==customerId)throw authFailure("Customer ownership denied",403);
  // The audit actor is the session subject itself, so every row and audit event names the customer who acted.
  const actor:AuthenticatedActor={email:session.auditId,name:`Customer ${customerId}`,roleCode:session.roleCode,permissions:session.permissions,developmentPreview:false,identitySource:session.identitySource,principalType:session.principalType,principalKey:session.principalKey,subjectType:"customer"};
  return{db,actor,customerId};
}

// Customer: the optional review destinations and the feedback-call offer for one completed booking.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),bookingId=text(url.searchParams.get("bookingId"));
    if(!bookingId)return json({error:"A booking is required"},400);
    const{db,customerId}=await customerContext(request,url.searchParams.get("customerId")||undefined);
    const policy=feedbackCallPolicyFromEnv(await runtime());
    const[invitation,call]=await Promise.all([postServiceReviewInvitation(db,{bookingId,customerId}),feedbackCallEligibility(db,{bookingId,customerId,policy})]);
    return json({data:{invitation,call}});
  }catch(error){return failure(error,"Unable to load post-service feedback options");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {action?:string;customerId?:string;bookingId?:string;preferredAt?:unknown;consentConfirmed?:unknown;limit?:unknown};
    const action=text(body.action);
    // Staff, non-production only: run the sweep with the synthetic no-dial placer. Nothing is dialled.
    if(action==="dispatch_due"){
      const db=await database(),actor=await resolveActor(request);requirePermission(actor,"communications.call");requirePermission(actor,"customers.manage");
      // The preview operator is a convenience identity, not a staff member; it may not run even the synthetic sweep.
      if(actor.developmentPreview)throw authFailure("Permission denied",403);
      const env=await runtime();
      if(!syntheticDispatchPermitted(env)){
        await securityAudit(db,actor,"post_service_feedback.call.dispatch","post_service_feedback_calls",null,"denied",{reason:"synthetic_dispatch_not_permitted"});
        return json({error:"Feedback-call dispatch is off. It runs only as a synthetic no-dial test in an explicitly non-production configuration.",code:"synthetic_dispatch_not_permitted"},403);
      }
      const data=await runPostServiceFeedbackCallSweep(db,{placer:syntheticFeedbackCallPlacer("route_synthetic_no_dial"),policy:feedbackCallPolicyFromEnv(env),actorId:actor.email,limit:Number(body.limit)||undefined});
      await securityAudit(db,actor,"post_service_feedback.call.dispatch","post_service_feedback_calls",null,"completed",{placer:data.placer,scanned:data.scanned,simulated:data.simulated,blocked:data.blocked,cancelled:data.cancelled,missed:data.missed,failed:data.failed});
      return json({data});
    }
    const bookingId=text(body.bookingId);
    if(!bookingId)return json({error:"A booking is required"},400);
    const{db,actor,customerId}=await customerContext(request,body.customerId);
    if(action==="schedule_call"){
      const data=await scheduleFeedbackCall(db,{bookingId,customerId,preferredAt:preferredAtMs(body.preferredAt),consentConfirmed:body.consentConfirmed===true,consentSource:"customer_app_feedback_call_request",actorId:customerId,policy:feedbackCallPolicyFromEnv(await runtime())});
      await securityAudit(db,actor,"post_service_feedback.call.schedule","customer",customerId,"completed",{bookingId,scheduleId:data.schedule.id,scheduledFor:data.schedule.scheduledFor,duplicatePrevented:data.duplicatePrevented});
      return json({data},data.duplicatePrevented?200:201);
    }
    if(action==="cancel_call"){
      const data=await cancelFeedbackCall(db,{bookingId,customerId,actorId:customerId});
      await securityAudit(db,actor,"post_service_feedback.call.cancel","customer",customerId,"completed",{bookingId,cancelled:data.cancelled});
      return json({data});
    }
    return json({error:"Unsupported action"},400);
  }catch(error){return failure(error,"Unable to complete the feedback request");}
}
