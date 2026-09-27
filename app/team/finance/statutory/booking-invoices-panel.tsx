"use client";
import{useState}from"react";
import{apiSend}from"../../../../lib/api-fetch";
type BacklogRow={bookingId:string;serviceCode:string;amountPaid:number;completedOn:string;daysSinceCompletion:number;status:string;message:string};
export type BookingInvoiceBacklog={asOf:string;rows:BacklogRow[];counts:{ready:number;tooLate:number;periodLocked:number;refused:number}};
export type ServiceSacs={seller:{legalName:string;gstin:string;state:string;stateCode:string;address:string}|null;refusal:string|null;rows:Array<{serviceCode:string;label:string;sac:string;description:string;source:string;valid:boolean;defaultSac:string;note:string}>};
export type FuneralTreatment={current:{treatment:string;effectiveFrom:string|null;source:string};versions:Array<{id:string;treatment:string;effectiveFrom:string;version:number;reason:string;createdBy:string}>;labels:Record<string,string>};
const money=(v:unknown)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v||0));
const STATUS:Record<string,string>={ready:"Ready to issue",too_late:"Not issued: more than 30 days after completion",period_locked:"Not issued: the month is closed",refused:"Needs configuration"};
const box={background:"var(--staff-raised)",border:"1px solid var(--staff-line)",borderRadius:12,padding:14} as const;
/** Customer tax invoices (owner decision B): who issues them, the completed bookings still without one and why, the SAC each
 * service is invoiced under, and how funeral / memorial is treated for GST. Every change needs finance.manage and a reason. */
export default function BookingInvoicesPanel({backlog,sacs,funeral,onSaved}:{backlog?:BookingInvoiceBacklog;sacs?:ServiceSacs;funeral?:FuneralTreatment;onSaved:()=>Promise<void>}){
 const[reason,setReason]=useState(""),[serviceCode,setServiceCode]=useState(""),[sac,setSac]=useState(""),[sacReason,setSacReason]=useState("");
 const[treatment,setTreatment]=useState("schedule_iii"),[effectiveFrom,setEffectiveFrom]=useState(""),[treatmentReason,setTreatmentReason]=useState("");
 const[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 async function send(body:Record<string,unknown>,fallback:string,done:(data:Record<string,unknown>)=>string){setBusy(true);setError("");setNotice("");try{const result=await apiSend<Record<string,unknown>>("/api/gst-accounting",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)},fallback);setNotice(done(result));await onSaved();}catch(problem){setError(problem instanceof Error?problem.message:fallback);}finally{setBusy(false);}}
 const rows=backlog?.rows??[],ready=backlog?.counts.ready??0;
 return <section style={{background:"var(--staff-surface)",border:"1px solid var(--staff-line)",padding:18,borderRadius:14,marginBottom:16}} aria-label="Customer tax invoices">
  <h2 style={{marginTop:0}}>Customer tax invoices</h2>
  <p style={{color:"var(--staff-muted)"}}>{sacs?.seller?`Issued by ${sacs.seller.legalName} · GSTIN ${sacs.seller.gstin} · ${sacs.seller.state} (${sacs.seller.stateCode}), the seller in the active tax policy. Every completed booking gets one invoice, dated the day it was completed, showing what the customer paid. GST is included and is 18% of the amount PawSpace makes.`:sacs?.refusal??"The seller in the active tax policy could not be read."}</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <article style={box}>
   <h3 style={{marginTop:0}}>Completed bookings without an invoice</h3>
   <p style={{margin:"0 0 8px",color:"var(--staff-muted)"}}>{rows.length?`${ready} ready to issue · ${backlog?.counts.refused??0} need configuration · ${backlog?.counts.tooLate??0} more than 30 days old · ${backlog?.counts.periodLocked??0} in a closed month`:"Every completed booking has its invoice."}</p>
   {rows.length>0&&<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:14}}><thead><tr>{["Booking","Service","Amount paid","Completed on","Status","Reason"].map(h=><th key={h} style={{textAlign:"left",padding:8}}>{h}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.bookingId}>{[row.bookingId,row.serviceCode.replaceAll("_"," "),money(row.amountPaid),row.completedOn,STATUS[row.status]??row.status,row.message].map((v,i)=><td key={i} style={{padding:8,borderTop:"1px solid var(--staff-line)"}}>{v}</td>)}</tr>)}</tbody></table></div>}
   <form onSubmit={e=>{e.preventDefault();void send({action:"issue_missing_booking_invoices",reason},"Unable to issue the missing invoices",data=>{const counts=data.counts as {issued?:number;notIssued?:number}|undefined;return`${counts?.issued??0} invoice(s) issued; ${counts?.notIssued??0} not issued (see the list for why)`;});}} style={{display:"flex",gap:10,alignItems:"end",flexWrap:"wrap",marginTop:10}}>
    <label style={{flex:"1 1 280px"}}>Reason<input required minLength={8} value={reason} onChange={e=>setReason(e.target.value)} placeholder="For example: series set up, issue the missing invoices" style={{width:"100%"}}/></label>
    <button disabled={busy||ready===0}>{busy?"Issuing…":"Issue missing invoices"}</button>
   </form>
  </article>
  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(320px,1fr))",gap:12,marginTop:12}} data-staff-grid="split">
   <article style={box}>
    <h3 style={{marginTop:0}}>SAC per service</h3>
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:14}}><thead><tr>{["Service","SAC","Description","Set by"].map(h=><th key={h} style={{textAlign:"left",padding:6}}>{h}</th>)}</tr></thead><tbody>{(sacs?.rows??[]).map(row=><tr key={row.serviceCode} title={row.note}><td style={{padding:6,borderTop:"1px solid var(--staff-line)"}}>{row.label}</td><td style={{padding:6,borderTop:"1px solid var(--staff-line)"}}>{row.sac}{row.valid?"":" (not a valid SAC)"}</td><td style={{padding:6,borderTop:"1px solid var(--staff-line)"}}>{row.description}</td><td style={{padding:6,borderTop:"1px solid var(--staff-line)"}}>{row.source==="finance"?"Finance":"Default"}</td></tr>)}</tbody></table>
    <form onSubmit={e=>{e.preventDefault();void send({action:"update_service_sac",serviceCode,sac,reason:sacReason},"Unable to change the SAC",()=>`SAC saved for ${serviceCode.replaceAll("_"," ")}; the next invoice uses it`);}} style={{display:"grid",gap:8,marginTop:10}}>
     <label>Service<select required value={serviceCode} onChange={e=>setServiceCode(e.target.value)}><option value="">Choose service</option>{(sacs?.rows??[]).map(row=><option key={row.serviceCode} value={row.serviceCode}>{row.label}</option>)}</select></label>
     <label>SAC (6 digits)<input required pattern="99[0-9]{2}([0-9]{2})?" value={sac} onChange={e=>setSac(e.target.value)} placeholder="998612"/></label>
     <label>Reason<input required minLength={8} value={sacReason} onChange={e=>setSacReason(e.target.value)} placeholder="For example: confirmed with our CA"/></label>
     <button disabled={busy||!sacs?.seller}>{busy?"Saving…":"Save SAC"}</button>
    </form>
   </article>
   <article style={box}>
    <h3 style={{marginTop:0}}>Funeral and memorial GST</h3>
    <p style={{margin:"0 0 8px"}}>{funeral?`Now: ${funeral.labels[funeral.current.treatment]??funeral.current.treatment}${funeral.current.effectiveFrom?`, from ${funeral.current.effectiveFrom}`:" (the default)"}.`:"The current treatment could not be read."}</p>
    <form onSubmit={e=>{e.preventDefault();void send({action:"save_funeral_gst_treatment",treatment,effectiveFrom,reason:treatmentReason},"Unable to change the funeral GST treatment",()=>`Funeral GST treatment saved from ${effectiveFrom}`);}} style={{display:"grid",gap:8}}>
     <label>Treatment<select value={treatment} onChange={e=>setTreatment(e.target.value)}>{Object.entries(funeral?.labels??{schedule_iii:"Outside GST (Schedule III)"}).map(([code,label])=><option key={code} value={code}>{label}</option>)}</select></label>
     <label>Effective from<input type="date" required value={effectiveFrom} onChange={e=>setEffectiveFrom(e.target.value)}/></label>
     <label>Reason<input required minLength={8} value={treatmentReason} onChange={e=>setTreatmentReason(e.target.value)} placeholder="For example: advice from our CA"/></label>
     <button disabled={busy}>{busy?"Saving…":"Save treatment"}</button>
    </form>
    {funeral&&funeral.versions.length>0&&<details style={{marginTop:8}}><summary>Earlier changes</summary><ul style={{margin:"6px 0 0",paddingLeft:20}}>{funeral.versions.map(v=><li key={v.id}>{funeral.labels[v.treatment]??v.treatment} from {v.effectiveFrom}, by {v.createdBy} ({v.reason})</li>)}</ul></details>}
   </article>
  </div>
 </section>;
}
