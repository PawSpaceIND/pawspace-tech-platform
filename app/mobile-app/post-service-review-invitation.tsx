"use client";
import{useEffect,useState}from"react";

type Destination={platform:"google"|"app";label:string;url:string};
type Invitation={bookingId:string;destinations:Destination[];source:string};
type Schedule={id:string;status:string;scheduledFor:number;timezone:string};
type CallOffer={eligible:boolean;reasons:string[];timezone:string|null;quietHours:{start:number;end:number}|null;existing:Schedule|null};
type Data={invitation:Invitation;call:CallOffer};

const article={padding:16,border:"1px solid var(--ps-border)",borderRadius:"calc(16px * var(--paw-radius-scale))",display:"grid",gap:10} as const;
const button={minHeight:44,borderRadius:"calc(12px * var(--paw-radius-scale))",border:"1px solid var(--ps-border)",background:"transparent",color:"inherit",fontWeight:700} as const;

/** Plain-language reason a call cannot be offered. Unknown codes fall back to a neutral sentence. */
function explain(reason:string){
 switch(reason){
  case "voice_consent_not_explicit":case "voice_consent_missing":return "We only call when you have told PawSpace it is okay to phone you. Your communication settings do not record that yet.";
  case "global_opt_out":case "voice_opt_out":return "You asked PawSpace not to contact you by phone, so no call will be offered.";
  case "service_updates_declined":return "You turned off service updates, so no call will be offered.";
  case "timezone_unknown":return "Your timezone is not on record, so we cannot pick a respectful time to call.";
  case "quiet_hours_policy_unknown":return "Calling hours are not configured for your city yet.";
  case "call_policy_unknown":case "voice_use_case_unavailable":return "Feedback calls are not configured yet.";
  case "phone_unknown":return "No phone number is on record for your account.";
  case "attempts_exhausted":return "A feedback call was already placed for this service.";
  default:return "A feedback call is not available for this service right now.";
 }
}

export default function PostServiceReviewInvitation({bookingId,customerId}:{bookingId:string;customerId?:string}){
 const[data,setData]=useState<Data|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[when,setWhen]=useState(""),[consent,setConsent]=useState(false),[reload,setReload]=useState(0);
 useEffect(()=>{const controller=new AbortController();const query=new URLSearchParams({bookingId});if(customerId)query.set("customerId",customerId);fetch(`/api/post-service-feedback?${query.toString()}`,{cache:"no-store",signal:controller.signal}).then(async response=>{const body=await response.json() as{data?:Data;error?:string};if(!response.ok||!body.data)throw new Error(body.error||"Unable to load review options");setError("");setData(body.data);}).catch(problem=>{if(controller.signal.aborted)return;setError(problem instanceof Error?problem.message:"Unable to load review options");});return()=>controller.abort();},[bookingId,customerId,reload]);
 const post=async(payload:Record<string,unknown>)=>{setBusy(true);setNotice("");setError("");try{const response=await fetch("/api/post-service-feedback",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...payload,bookingId,...(customerId?{customerId}:{})})});const body=await response.json() as{data?:unknown;error?:string};if(!response.ok)throw new Error(body.error||"Unable to update your feedback call");return body.data;}catch(problem){setError(problem instanceof Error?problem.message:"Unable to update your feedback call");return null;}finally{setBusy(false);}};
 const schedule=async()=>{if(!when||!consent)return;const result=await post({action:"schedule_call",preferredAt:new Date(when).toISOString(),consentConfirmed:true});if(result){setNotice("Your feedback call is scheduled. You can cancel it here at any time.");setReload(value=>value+1);}};
 const cancel=async()=>{const result=await post({action:"cancel_call"});if(result){setNotice("Your feedback call has been cancelled.");setReload(value=>value+1);}};
 if(error&&!data)return <article style={article} aria-label="Share an honest review"><p role="alert" style={{margin:0}}>{error}</p></article>;
 if(!data)return <article style={article} aria-label="Share an honest review"><p style={{margin:0}}>Loading review options…</p></article>;
 const{invitation,call}=data;
 return <section style={{display:"grid",gap:12}}>
  <article style={article} aria-label="Share an honest review">
   <span>OPTIONAL · PUBLIC REVIEW</span>
   <h3 style={{margin:0}}>Share an honest review</h3>
   <p style={{margin:0}}>If you would like to, you can tell others about your genuine experience on a public review site. This is entirely optional, it is never a condition of anything PawSpace offers you, and PawSpace does not check whether you post. Please share only what you honestly experienced, whatever it was.</p>
   {invitation.destinations.length===0?<small>No approved public review page is configured for this service yet, so there is no link to show.</small>:<div style={{display:"grid",gap:8}}>{invitation.destinations.map(destination=><a key={destination.platform} href={destination.url} target="_blank" rel="noreferrer noopener" style={{...button,display:"inline-flex",alignItems:"center",justifyContent:"center",textDecoration:"none"}}>Open the PawSpace page on {destination.label} ↗</a>)}</div>}
  </article>
  <article style={article} aria-label="Feedback call">
   <span>OPTIONAL · FEEDBACK CALL</span>
   <h3 style={{margin:0}}>Prefer to talk? Ask for a feedback call</h3>
   <p style={{margin:0}}>PawSpace will only call if you ask, only at the time you choose outside quiet hours, and only to hear your feedback about this service. You can cancel at any time.</p>
   {call.existing?<>
    <p style={{margin:0}}>Scheduled for <b>{new Date(call.existing.scheduledFor).toLocaleString("en-IN",{timeZone:call.existing.timezone,day:"numeric",month:"short",hour:"numeric",minute:"2-digit"})}</b> ({call.existing.timezone}).</p>
    <button type="button" disabled={busy} onClick={()=>void cancel()} style={button}>{busy?"Updating…":"Cancel this call"}</button>
   </>:call.eligible?<>
    <label style={{display:"grid",gap:6}}><b style={{fontSize:12}}>Choose a time ({call.timezone}{call.quietHours?`, no calls ${call.quietHours.start}:00–${call.quietHours.end}:00`:""})</b><input type="datetime-local" value={when} disabled={busy} onChange={event=>setWhen(event.target.value)} style={{minHeight:44,borderRadius:"calc(10px * var(--paw-radius-scale))",border:"1px solid var(--ps-border)",padding:"0 10px"}}/></label>
    <label style={{display:"flex",gap:8,alignItems:"flex-start"}}><input type="checkbox" checked={consent} disabled={busy} onChange={event=>setConsent(event.target.checked)} style={{marginTop:4}}/><span>I am asking PawSpace to make one automated feedback call to my registered number at the time I chose. I understand I can cancel this request at any time.</span></label>
    <button type="button" disabled={busy||!when||!consent} onClick={()=>void schedule()} style={button}>{busy?"Scheduling…":"Request feedback call"}</button>
   </>:<small>{explain(call.reasons[0]||"")}</small>}
   {notice&&<p role="status" style={{margin:0}}>{notice}</p>}
   {error&&<p role="alert" style={{color:"#b3261e",margin:0}}>{error}</p>}
  </article>
 </section>;
}
