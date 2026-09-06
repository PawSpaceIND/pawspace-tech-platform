import{ensureVoiceCallTables,recordVoiceProviderEvent}from"./voice-outbound-governance";
import{normaliseTelephonyEvent,TelephonyProviderUnavailable,type TelephonyProvider,type TelephonyProviderEvent}from"./voice-telephony-provider";
import{ProviderResponseTooLarge,readBoundedText as readBoundedResponseText}from"./provider-response-bounds";

type Db=D1Database;
type Env=Record<string,unknown>;
type Row=Record<string,unknown>;
type ExotelCall=Record<string,unknown>&{Details?:Record<string,unknown>};

const text=(value:unknown)=>String(value??"").trim();
const val=(env:Env,key:string)=>text(env?.[key]);
const EXOTEL_DETAILS_TIMEOUT_MS=12_000;
const MAX_EXOTEL_DETAILS_BYTES=64*1024;
const MAX_CALL_SID_LENGTH=160;

function triggerFields(rawBody:string){
 const out=new Map<string,string>();
 const raw=String(rawBody??"").trim();
 if(raw.startsWith("{")){
  let parsed:Record<string,unknown>={};
  try{parsed=JSON.parse(raw)as Record<string,unknown>}catch{return out;}
  for(const[key,value]of Object.entries(parsed))if(value!==null&&typeof value!=="object")out.set(key.toLowerCase(),String(value));
 }else for(const[key,value]of new URLSearchParams(raw))out.set(key.toLowerCase(),value);
 return out;
}

/**
 * The public callback is intentionally NOT trusted for status, call reference, duration or recording.
 * Only its provider-assigned CallSid is used as a reconciliation trigger.
 */
export function extractExotelCallSid(rawBody:string){
 const fields=triggerFields(rawBody);
 const sid=text(fields.get("callsid")||fields.get("call_sid")||fields.get("sid"));
 if(!sid||sid.length>MAX_CALL_SID_LENGTH)return null;
 return/^[A-Za-z0-9._:-]+$/.test(sid)?sid:null;
}

function exotelApiHost(env:Env){
 const host=(val(env,"EXOTEL_SUBDOMAIN")||"api.exotel.com").toLowerCase();
 if(!/^[a-z0-9.-]+$/.test(host)||!(host==="exotel.com"||host.endsWith(".exotel.com")))throw new TelephonyProviderUnavailable("Exotel API host is not approved");
 return host;
}

async function fetchAuthoritativeCall(env:Env,callSid:string){
 const key=val(env,"EXOTEL_API_KEY"),token=val(env,"EXOTEL_API_TOKEN"),accountSid=val(env,"EXOTEL_SID");
 if(!key||!token||!accountSid)throw new TelephonyProviderUnavailable("Exotel Call Details credentials are not configured");
 // Use the single-call resource rather than the bulk /Calls search. Exotel's bulk Call Details API
 // explicitly omits ongoing calls, which would make an in-progress/connected callback impossible to
 // reconcile authoritatively. Appending .json keeps the provider response deterministic for parsing.
 const url=new URL(`https://${exotelApiHost(env)}/v1/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(callSid)}.json`);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),EXOTEL_DETAILS_TIMEOUT_MS);
 try{
  let response:Response,body:string;
  try{
   response=await fetch(url.toString(),{method:"GET",headers:{authorization:`Basic ${btoa(`${key}:${token}`)}`,accept:"application/json"},signal:controller.signal});
   body=await readBoundedResponseText(response,MAX_EXOTEL_DETAILS_BYTES);
  }catch(error){
   if(error instanceof ProviderResponseTooLarge)throw new TelephonyProviderUnavailable("Exotel Call Details response exceeded the size limit");
   throw new TelephonyProviderUnavailable(controller.signal.aborted?`Exotel Call Details did not respond within ${EXOTEL_DETAILS_TIMEOUT_MS}ms`:`Exotel Call Details request failed: ${text((error as Error)?.message||error).slice(0,120)}`);
  }
  if(!response.ok)throw new TelephonyProviderUnavailable(`Exotel Call Details rejected reconciliation (${response.status})`);
  let parsed:Record<string,unknown>={};
  try{parsed=JSON.parse(body)as Record<string,unknown>}catch{throw new TelephonyProviderUnavailable("Exotel Call Details returned malformed JSON");}
  const candidate=parsed.Call??parsed.call??parsed;
  if(!candidate||typeof candidate!=="object"||Array.isArray(candidate))throw new TelephonyProviderUnavailable("Exotel Call Details returned no call resource");
  const call=candidate as ExotelCall;
  const returnedSid=text(call.Sid||call.sid||call.CallSid||call.callSid||call.call_sid);
  if(returnedSid!==callSid)throw new TelephonyProviderUnavailable("Exotel Call Details did not return the requested CallSid");
  if(!text(call.Status||call.status))throw new TelephonyProviderUnavailable("Exotel Call Details returned no authoritative status");
  return{call,body};
 }finally{clearTimeout(timer);}
}

function authoritativeEvent(call:ExotelCall,callSid:string,callId:string):TelephonyProviderEvent{
 const details=(call.Details&&typeof call.Details==="object"?call.Details:{})as Record<string,unknown>;
 const duration=text(call.Duration||call.duration||details.ConversationDuration||details.conversationDuration||details.conversation_duration);
 const recording=text(call.RecordingUrl||call.recordingUrl||call.recording_url);
 const body=new URLSearchParams({CallSid:callSid,CustomField:callId,CallStatus:text(call.Status||call.status)});
 if(duration)body.set("CallDuration",duration);
 if(recording)body.set("RecordingUrl",recording);
 return normaliseTelephonyEvent(body.toString(),"exotel");
}

function authoritativeProvider(event:TelephonyProviderEvent):TelephonyProvider{
 return{
  provider:"exotel",status:"connected",productionCapable:true,
  async createCall(){throw new TelephonyProviderUnavailable("Authoritative reconciliation provider cannot place calls");},
  async verifyWebhook(){return{verified:true,mechanism:"exotel_call_details_api",reason:null};},
  parseEvent(){return event;},
 };
}

/**
 * Reconcile an unverified Exotel callback trigger against two independent trust anchors:
 *   1. the CallSid must already belong to an Exotel call in PawSpace's D1 ledger;
 *   2. Exotel's authenticated Call Details API must return the same Sid and authoritative status.
 *
 * The incoming CallStatus, CustomField, duration and recording URL are ignored. The raw Call Details
 * response is only SHA-256 hashed by recordVoiceProviderEvent; it is never persisted as provider data.
 */
export async function recordVoiceProviderEventFromExotelReconciliation(db:Db,env:Env,rawTriggerBody:string){
 await ensureVoiceCallTables(db);
 const callSid=extractExotelCallSid(rawTriggerBody);
 if(!callSid)return{accepted:false,status:400,reason:"Exotel callback trigger is missing a valid CallSid",duplicate:false};
 const owned=await db.prepare("SELECT id,state FROM voice_call_orders WHERE provider='exotel' AND provider_call_id=? LIMIT 1").bind(callSid).first<Row>();
 // Do not turn this public route into an authenticated Exotel API proxy for arbitrary Sids. Unknown
 // provider ids are acknowledged and ignored without any outbound provider request.
 if(!owned)return{accepted:true,status:202,reason:"Unknown Exotel call trigger ignored",duplicate:false,applied:false};
 try{
  const authoritative=await fetchAuthoritativeCall(env,callSid);
  const event=authoritativeEvent(authoritative.call,callSid,text(owned.id));
  const provider=authoritativeProvider(event);
  return await recordVoiceProviderEvent(db,env,{rawBody:authoritative.body,headers:new Headers(),provider});
 }catch(error){
  const reason=error instanceof TelephonyProviderUnavailable?error.message:"Exotel call reconciliation failed";
  return{accepted:false,status:503,reason:text(reason).slice(0,200),duplicate:false};
 }
}
