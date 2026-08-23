import { randomUUID } from "node:crypto";
import type { Booking, CommunicationPreference, NotificationEvent } from "./domain.js";

export class Lane3Error extends Error {
  constructor(public readonly code:string,message:string){super(message);this.name="Lane3Error";}
}

const id=()=>randomUUID().replaceAll("-","").slice(0,16);
const fail=(code:string,message:string):never=>{throw new Lane3Error(code,message);};

export interface LocationUpdate { bookingId:string; providerId:string; latitude:number; longitude:number; capturedAt:string; idempotencyKey:string; permissionGranted?:boolean; }
export interface StoredLocation extends LocationUpdate { cityId:string; zoneId:string; acceptedAt:string; }

export class LocationTracker {
  private readonly byBooking=new Map<string,StoredLocation>();
  private readonly byKey=new Map<string,StoredLocation>();
  constructor(private readonly staleAfterMs=10*60_000,private readonly futureToleranceMs=2*60_000){}

  update(booking:Booking,input:LocationUpdate,at=new Date()):StoredLocation{
    if(input.bookingId!==booking.id)fail("BOOKING_MISMATCH","Location update does not match the booking");
    if(!booking.providerId||input.providerId!==booking.providerId)fail("PROVIDER_NOT_ASSIGNED","Only the currently assigned provider may update location");
    if(input.permissionGranted===false)fail("LOCATION_PERMISSION_DENIED","Location permission was denied");
    if(!Number.isFinite(input.latitude)||input.latitude < -90||input.latitude > 90||!Number.isFinite(input.longitude)||input.longitude < -180||input.longitude > 180)fail("INVALID_COORDINATES","Coordinates are outside valid latitude/longitude ranges");
    const captured=new Date(input.capturedAt).getTime();
    const current=at.getTime();
    if(!Number.isFinite(captured))fail("INVALID_CAPTURE_TIME","Location capture time is invalid");
    if(captured < current-this.staleAfterMs)fail("STALE_LOCATION","Location update is too old");
    if(captured > current+this.futureToleranceMs)fail("FUTURE_LOCATION","Location update is too far in the future");
    const priorKey=this.byKey.get(input.idempotencyKey);
    if(priorKey){
      if(priorKey.bookingId!==input.bookingId||priorKey.providerId!==input.providerId||priorKey.latitude!==input.latitude||priorKey.longitude!==input.longitude||priorKey.capturedAt!==input.capturedAt)fail("IDEMPOTENCY_CONFLICT","Idempotency key was reused with different location data");
      return priorKey;
    }
    const existing=this.byBooking.get(booking.id);
    if(existing&&new Date(input.capturedAt).getTime()<new Date(existing.capturedAt).getTime())fail("OUT_OF_ORDER_LOCATION","Older location cannot replace a newer provider location");
    const stored:StoredLocation={...input,cityId:booking.cityId,zoneId:booking.zoneId,acceptedAt:at.toISOString()};
    this.byBooking.set(booking.id,stored);this.byKey.set(input.idempotencyKey,stored);return stored;
  }

  customerView(booking:Booking,mapsReady:boolean,at=new Date()){
    const location=this.byBooking.get(booking.id);
    if(!location||location.providerId!==booking.providerId)return {available:false,trackingReady:false,reason:"LOCATION_UNAVAILABLE"};
    const stale=new Date(location.capturedAt).getTime()<at.getTime()-this.staleAfterMs;
    if(stale)return {available:false,trackingReady:false,reason:"STALE_LOCATION"};
    return {available:true,trackingReady:mapsReady,routeReady:mapsReady,reason:mapsReady?undefined:"MAPS_NOT_CONFIGURED",location:{latitude:location.latitude,longitude:location.longitude,capturedAt:location.capturedAt,cityId:location.cityId,zoneId:location.zoneId}};
  }
}

export type ProofKind="before"|"after"|"completion";
export interface ServiceProof { id:string; bookingId:string; providerId:string; kind:ProofKind; objectRef:string; idempotencyKey:string; createdAt:string; }

export class ServiceProofStore {
  private readonly byKey=new Map<string,ServiceProof>();
  private readonly byBooking=new Map<string,ServiceProof[]>();
  constructor(private readonly storageConfigured:boolean){}

  submit(booking:Booking,input:{providerId:string;kind:ProofKind;objectRef:string;idempotencyKey:string},at=new Date()):ServiceProof{
    if(!this.storageConfigured)fail("MEDIA_STORAGE_NOT_CONFIGURED","Proof storage is unavailable");
    if(!booking.providerId||input.providerId!==booking.providerId)fail("PROOF_PROVIDER_MISMATCH","Only the assigned provider may submit service proof");
    if(!/^(media|r2|s3):\/\/[A-Za-z0-9._~!$&'()*+,;=:@\/-]+$/.test(input.objectRef))fail("INVALID_OBJECT_REF","Proof requires a valid private object reference");
    const prior=this.byKey.get(input.idempotencyKey);
    if(prior){
      if(prior.bookingId!==booking.id||prior.providerId!==input.providerId||prior.kind!==input.kind||prior.objectRef!==input.objectRef)fail("IDEMPOTENCY_CONFLICT","Proof idempotency key was reused with different data");
      return prior;
    }
    const proof:ServiceProof={id:`proof_${id()}`,bookingId:booking.id,providerId:input.providerId,kind:input.kind,objectRef:input.objectRef,idempotencyKey:input.idempotencyKey,createdAt:at.toISOString()};
    this.byKey.set(input.idempotencyKey,proof);this.byBooking.set(booking.id,[...(this.byBooking.get(booking.id)??[]),proof]);return proof;
  }

  completionState(bookingId:string,required:ProofKind[]=["before","after"]){
    const kinds=new Set((this.byBooking.get(bookingId)??[]).map(x=>x.kind));
    const missing=required.filter(kind=>!kinds.has(kind));
    return {completionAllowed:missing.length===0,missingProof:missing};
  }
}

export function evaluateCommunicationPolicy(input:{preference:CommunicationPreference|null;channel:NotificationEvent["channels"][number];purpose:"service"|"reminder"|"marketing";at:Date;sentInLast24Hours:number;frequencyCap?:number}){
  const {preference,channel,purpose,at}=input;
  if(!preference)return {allowed:false,reason:"PREFERENCE_NOT_FOUND"};
  if(!preference.channels.includes(channel))return {allowed:false,reason:"CHANNEL_OPTED_OUT"};
  if(purpose==="service"&&!preference.serviceUpdates)return {allowed:false,reason:"SERVICE_UPDATES_OPTED_OUT"};
  if(purpose==="reminder"&&!preference.reminders)return {allowed:false,reason:"REMINDERS_OPTED_OUT"};
  if(purpose==="marketing"&&!preference.marketing)return {allowed:false,reason:"MARKETING_OPTED_OUT"};
  const [startHour,startMinute]=preference.quietHoursStart.split(":").map(Number);
  const [endHour,endMinute]=preference.quietHoursEnd.split(":").map(Number);
  if([startHour,startMinute,endHour,endMinute].every(Number.isFinite)){
    const minute=at.getUTCHours()*60+at.getUTCMinutes();const start=(startHour??0)*60+(startMinute??0);const end=(endHour??0)*60+(endMinute??0);
    const quiet=start===end?false:start<end?minute>=start&&minute<end:minute>=start||minute<end;
    if(quiet)return {allowed:false,reason:"QUIET_HOURS"};
  }
  if(input.sentInLast24Hours>=(input.frequencyCap??3))return {allowed:false,reason:"FREQUENCY_CAP"};
  return {allowed:true,reason:"ALLOWED"};
}

export type AiAction="answer"|"draft"|"refund"|"payment"|"payout"|"pricing_change"|"outbound_contact"|"customer_merge"|"provider_assignment"|"campaign_activation";
const humanGated=new Set<AiAction>(["refund","payment","payout","pricing_change","outbound_contact","customer_merge","provider_assignment","campaign_activation"]);
export interface AiResult { status:"ok"|"handoff"; auditTraceId:string; humanApprovalRequired:boolean; canExecute:boolean; text?:string; reason?:string; }

export async function runAiAssistant(input:{configured:boolean;action:AiAction;prompt:string;timeoutMs?:number},provider?:()=>Promise<unknown>):Promise<AiResult>{
  const auditTraceId=`ai_${id()}`;const gated=humanGated.has(input.action);
  const handoff=(reason:string):AiResult=>({status:"handoff",auditTraceId,humanApprovalRequired:true,canExecute:false,reason});
  if(!input.configured)return handoff("AI_NOT_CONFIGURED");
  if(!provider)return handoff("AI_PROVIDER_UNAVAILABLE");
  try{
    const timeoutMs=input.timeoutMs??2_000;
    const output=await Promise.race([provider(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Lane3Error("AI_TIMEOUT","AI provider timed out")),timeoutMs))]);
    if(!output||typeof output!=="object"||!("text" in output)||typeof (output as {text?:unknown}).text!=="string")return handoff("AI_MALFORMED_RESPONSE");
    const text=(output as {text:string}).text.trim();if(!text)return handoff("AI_EMPTY_RESPONSE");
    return {status:"ok",auditTraceId,humanApprovalRequired:gated,canExecute:!gated,text,reason:gated?"HUMAN_APPROVAL_REQUIRED":undefined};
  }catch(error){return handoff(error instanceof Lane3Error&&error.code==="AI_TIMEOUT"?"AI_TIMEOUT":"AI_TOOL_OR_PROVIDER_FAILURE");}
}

export function voiceSafetyState(env:NodeJS.ProcessEnv=process.env){
  const enabled=env.VOICE_TELEPHONY_ENABLED==="true";const configured=Boolean(env.VOICE_PROVIDER_API_KEY?.trim());
  if(!enabled)return {enabled:false,configured,safe:true,canDial:false,reason:"VOICE_DISABLED"};
  if(!configured)return {enabled:true,configured:false,safe:true,canDial:false,reason:"VOICE_PROVIDER_NOT_CONFIGURED"};
  return {enabled:true,configured:true,safe:true,canDial:true,reason:"CONTROLLED_TEST_ONLY"};
}
