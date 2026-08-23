import{authError,authorize,database,requirePermission,securityAudit}from"../../../lib/server-auth";
import{attachVoiceTranscript,cancelVoiceCall,completeVoiceCall,evaluateVoiceCallPolicy,recordVoiceConsent,recordVoiceOptOut,recordVoiceOptOutDuringCall,recordVoiceSpeechFailure,requestOutboundVoiceCall,requestVoiceHumanHandoff,retryVoiceCall,setVoiceCallScript,transitionVoiceCall,voiceCallAudit,voiceCallLedger,voiceOutboundReadiness}from"../../../lib/voice-outbound-governance";
import{resolveVoiceCallGate}from"../../../lib/voice-call-gate";

type Body=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(value:unknown)=>String(value??"").trim();
async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin voice write blocked",{status:403});}

/**
 * Staff surface for automated outbound voice calling.
 *
 * Two permissions, both required: communications.call (may contact a customer) AND customers.manage
 * (may act on the customer record). service_provider and associate hold the first but not the second,
 * which is the intended boundary - a field provider may call a customer from their own phone, but may
 * not launch an automated dialler at one. auditor and finance hold neither.
 *
 * Whether voice is enabled at all is decided by the ENVIRONMENT (lib/voice-call-gate.ts). No field of
 * any request reaching this route can turn it on, and a refusal is still written to the call ledger so
 * the reason is auditable rather than a bare 503.
 */
export async function GET(request:Request){
  try{
    const actor=await authorize(request,"customers.manage");requirePermission(actor,"communications.call");
    const url=new URL(request.url),db=await database(),env=await runtime();
    const scope=url.searchParams.get("scope")||"readiness";
    if(scope==="audit"){const callId=text(url.searchParams.get("callId"));if(!callId)return json({error:"callId is required"},400);return json({data:await voiceCallAudit(db,callId)});}
    if(scope==="ledger")return json({data:await voiceCallLedger(db,{limit:Number(url.searchParams.get("limit")||50),state:url.searchParams.get("state")||undefined})});
    return json({data:await voiceOutboundReadiness(db,env)});
  }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to load voice outbound state");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const actor=await authorize(request,"customers.manage");requirePermission(actor,"communications.call");
    const body=await request.json().catch(()=>({}))as Body,action=text(body.action)||"request_call";
    const db=await database(),env=await runtime();
    const permissions=actor.permissions as string[];

    if(action==="set_script"){
      requirePermission(actor,"settings.manage");
      const data=await setVoiceCallScript(db,{useCase:text(body.useCase),openingDisclosure:text(body.openingDisclosure),body:Array.isArray(body.body)?body.body.map(text):[],claimsApproved:Boolean(body.claimsApproved),active:body.active!==false,actorId:actor.email});
      await securityAudit(db,actor,"voice.script.set","voice_call_script",text(body.useCase),"completed",{version:data.version});
      return json({data},201);
    }
    if(action==="record_consent"){
      const data=await recordVoiceConsent(db,{phone:text(body.phone),subjectType:body.subjectType==="lead"?"lead":"customer",subjectId:text(body.subjectId)||null,granted:Boolean(body.granted),source:text(body.source),actorId:actor.email});
      await securityAudit(db,actor,"voice.consent.record","voice_call_consent",data.phoneKey.slice(-4),"completed",{granted:data.granted});
      return json({data},201);
    }
    if(action==="record_opt_out"){
      const data=await recordVoiceOptOut(db,{phone:text(body.phone),source:text(body.source)||"staff_request",reason:text(body.reason)||null,actorId:actor.email});
      await securityAudit(db,actor,"voice.opt_out.record","voice_call_opt_out",data.phoneKey.slice(-4),"completed",{});
      return json({data},201);
    }
    if(action==="policy_preview"){
      // Dry run: what WOULD block this call, with nothing created and nothing dialled.
      const data=await evaluateVoiceCallPolicy(db,env,{idempotencyKey:"preview",useCase:text(body.useCase),phone:text(body.phone),cityId:text(body.cityId)||"blr",customerId:text(body.customerId)||null,leadId:text(body.leadId)||null,bookingId:text(body.bookingId)||null,actorId:actor.email,actorPermissions:permissions});
      return json({data:{allowed:data.allowed,blockedBy:data.blockedBy,blockedDetail:data.blockedDetail,checks:data.checks,dialled:false}});
    }

    if(action==="request_call"){
      const gate=resolveVoiceCallGate(env);
      const data=await requestOutboundVoiceCall(db,env,{idempotencyKey:text(body.idempotencyKey),useCase:text(body.useCase),phone:text(body.phone),cityId:text(body.cityId)||"blr",customerId:text(body.customerId)||null,leadId:text(body.leadId)||null,bookingId:text(body.bookingId)||null,campaignId:text(body.campaignId)||null,actorId:actor.email,actorPermissions:permissions,simulatedOutcome:null});
      await securityAudit(db,actor,"voice.call.request","voice_call",data.callId,data.state.startsWith("blocked_")?"denied":"completed",{state:data.state,useCase:data.useCase,productionCall:data.productionCall});
      return json({data},gate.ok?201:503);
    }
    if(action==="retry"){
      const data=await retryVoiceCall(db,env,{callId:text(body.callId),actorId:actor.email,actorPermissions:permissions,idempotencyKey:text(body.idempotencyKey)||undefined});
      await securityAudit(db,actor,"voice.call.retry","voice_call",data.callId,"completed",{retryOf:data.retryOf,state:data.state});
      return json({data},201);
    }

    const callId=text(body.callId);
    if(!callId)return json({error:"callId is required"},400);
    let data:unknown;
    if(action==="conversation_turn"){
      const turn=text(body.turn);
      if(turn!=="speaking"&&turn!=="listening")return json({error:"turn must be speaking or listening"},400);
      data=await transitionVoiceCall(db,{callId,to:turn,reason:text(body.reason)||`Bot ${turn}`,actor:actor.email,detail:{interrupted:Boolean(body.interrupted)}});
    }
    else if(action==="speech_failure")data=await recordVoiceSpeechFailure(db,{callId,kind:body.kind==="tts"?"tts":"stt",reason:text(body.reason),actorId:actor.email});
    else if(action==="handoff")data=await requestVoiceHumanHandoff(db,{callId,reason:text(body.reason)||"Human handoff requested",actorId:actor.email,customerId:text(body.customerId)||null});
    else if(action==="opt_out")data=await recordVoiceOptOutDuringCall(db,{callId,reason:text(body.reason)||null,actorId:actor.email});
    else if(action==="attach_transcript")data=await attachVoiceTranscript(db,{callId,transcriptRef:text(body.transcriptRef),aiCallId:text(body.aiCallId)||null});
    else if(action==="cancel")data=await cancelVoiceCall(db,{callId,reason:text(body.reason)||"Cancelled by operator",actorId:actor.email});
    else if(action==="complete")data=await completeVoiceCall(db,{callId,reason:text(body.reason)||"Call completed",actorId:actor.email});
    else return json({error:`Unsupported voice action: ${action}`},400);
    await securityAudit(db,actor,`voice.call.${action}`,"voice_call",callId,"completed",{});
    return json({data});
  }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to process voice outbound action");}
}
