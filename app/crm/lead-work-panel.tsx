"use client";
import{FormEvent,useState}from"react";

/**
 * Work the selected customer's open lead from the CRM detail: record a call's outcome with a note, and
 * schedule the callback the customer asked for. [round-2 L1: "a lead cannot be given a note, a next
 * action or a new stage from the CRM"]
 *
 * Both controls post to the Revenue & CX engine's existing lead actions (log_attempt, schedule_callback),
 * so the rules are the engine's: "Interested" moves the contact to Qualified, "Invalid" and "Opt-out"
 * close the lead (an opt-out also stops every channel), any logged call meets the lead's first-response
 * clock, and a callback needs a real future time and the customer's reason. An associate can work the
 * leads assigned to them; the engine refuses anyone else's with its own message, shown here.
 */
const OUTCOMES:Array<[string,string]>=[
 ["Connected","Connected - spoke to the customer"],
 ["Interested","Interested - move to Qualified"],
 ["Not interested","Not interested"],
 ["RNR","No answer (RNR)"],
 ["Invalid","Invalid number - close the lead"],
 ["Opt-out","Asked not to be contacted - close the lead"],
];
const box={margin:"12px 16px",padding:12,display:"grid",gap:8,border:"1px solid var(--staff-line, #e4dce9)",borderRadius:12,background:"var(--staff-surface, #fff)"} as const;
const field={display:"grid",gap:4,fontSize:13} as const;

export default function LeadWorkPanel({leadId,onSaved}:{leadId:string;onSaved:(message:string)=>void}){
 const[busy,setBusy]=useState(false),[error,setError]=useState("");
 async function send(body:Record<string,unknown>,success:string){
  setBusy(true);setError("");
  try{
   const response=await fetch("/api/revenue-crm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,leadId})});
   const result=await response.json().catch(()=>({})) as {error?:string};
   if(!response.ok)throw new Error(result.error||`Not saved (HTTP ${response.status})`);
   onSaved(success);return true;
  }catch(reason){setError(reason instanceof Error?reason.message:"Not saved");return false;}
  finally{setBusy(false);}
 }
 async function logCall(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const form=event.currentTarget,data=new FormData(form);
  if(await send({action:"log_attempt",channel:"call",outcome:String(data.get("outcome")),note:String(data.get("note")||"").trim()},"Call outcome saved"))form.reset();
 }
 async function scheduleCallback(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const form=event.currentTarget,data=new FormData(form),requestedAt=new Date(String(data.get("when")||"")).getTime();
  if(!Number.isFinite(requestedAt)){setError("Choose when to call back");return;}
  if(await send({action:"schedule_callback",requestedAt,reason:String(data.get("reason")||"").trim()},"Callback scheduled"))form.reset();
 }
 return <section aria-label="Work this lead" style={{display:"grid"}}>
  <form onSubmit={logCall} style={box}>
   <strong style={{fontSize:13}}>Log a call · {leadId}</strong>
   <label style={field}>Outcome<select name="outcome" defaultValue="Connected">{OUTCOMES.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label style={field}>Note<textarea name="note" rows={2} maxLength={500} placeholder="What the customer said"/></label>
   <button type="submit" disabled={busy}>{busy?"Saving…":"Save call outcome"}</button>
  </form>
  <form onSubmit={scheduleCallback} style={box}>
   <strong style={{fontSize:13}}>Schedule a callback</strong>
   <label style={field}>When<input name="when" type="datetime-local" required/></label>
   <label style={field}>Reason<input name="reason" required minLength={8} maxLength={200} placeholder="What the customer asked for"/></label>
   <button type="submit" disabled={busy}>{busy?"Saving…":"Schedule callback"}</button>
  </form>
  {error&&<p role="alert" style={{margin:"0 16px 12px",color:"var(--staff-danger, #8c2f22)",fontSize:13}}>{error}</p>}
 </section>;
}
