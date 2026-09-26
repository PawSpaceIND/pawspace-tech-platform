"use client";
import{useState}from"react";
import{apiSend}from"../../../../lib/api-fetch";
type Row=Record<string,unknown>;
type Account={account:string;opening:number;accrued:number;paid:number;closing:number;difference:number;explanation:string;paymentsRecordedForPeriod:number};
type View={periodCode:string;status:"reconciled"|"differences";gst:Account&{filedServiceGst:number;serviceTaxableValue:number;serviceExemptValue:number;notYetClassifiedGst:number;latestGstr3bServiceGst:number|null;unpaidForPeriod:number;sameBookings:{supplies:number;postedGst:number;filedGst:number;agrees:boolean}};tcs:Account&{tcsCollections:number;gstr8PreparedTcs:number|null;deposit:{amount:number;challanReference:string}|null;sameBookings:{bookings:number;mismatches:Row[]}}};
const previousMonth=()=>{const d=new Date(Date.now()+330*60_000);d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-1);return d.toISOString().slice(0,7);};
const money=(v:unknown)=>v==null?"Not prepared":new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v));
const box={background:"var(--staff-raised)",border:"1px solid var(--staff-line)",borderRadius:12,padding:14};
/** GST and TCS payable for one month: ledger accounts 2130 and 2140 against the returns and GSTR-8, the "tax paid" step, and
 * assigning a whole month's service supplies to their legal entity before the month can be closed. */
export default function TaxPayablePanel({entities,registrations}:{entities:Row[];registrations:Row[]}){
 const[period,setPeriod]=useState(previousMonth()),[view,setView]=useState<View|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const[taxKind,setTaxKind]=useState("gst"),[amount,setAmount]=useState(""),[challan,setChallan]=useState(""),[paidOn,setPaidOn]=useState(""),[reason,setReason]=useState("");
 const[entityId,setEntityId]=useState(""),[registrationId,setRegistrationId]=useState(""),[ownerReason,setOwnerReason]=useState("");
 async function load(){setBusy(true);setError("");try{setView(await apiSend<View>(`/api/gst-accounting?view=tax_reconciliation&period=${encodeURIComponent(period)}`,{cache:"no-store"},"Unable to load GST and TCS payable"));}catch(problem){setError(problem instanceof Error?problem.message:"Unable to load GST and TCS payable");}finally{setBusy(false);}}
 async function send(body:Record<string,unknown>,fallback:string,done:string){setBusy(true);setError("");setNotice("");try{await apiSend("/api/gst-accounting",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)},fallback);setNotice(done);setBusy(false);await load();}catch(problem){setError(problem instanceof Error?problem.message:fallback);setBusy(false);}}
 const line=(name:string,value:unknown)=><div style={{display:"flex",justifyContent:"space-between",gap:12,padding:"4px 0"}}><span>{name}</span><b style={{fontVariantNumeric:"tabular-nums"}}>{typeof value==="string"?value:money(value)}</b></div>;
 return <section style={{background:"var(--staff-surface)",border:"1px solid var(--staff-line)",padding:18,borderRadius:14,marginBottom:16}}>
  <h2 style={{marginTop:0}}>GST and TCS payable</h2>
  <p style={{color:"var(--staff-muted)"}}>Ledger accounts 2130 (GST) and 2140 (TCS) for a month, next to the GST the returns file and the TCS computed for GSTR-8. Record a payment only after it has been made on the GST portal.</p>
  <form onSubmit={e=>{e.preventDefault();void load();}} style={{display:"flex",gap:12,alignItems:"end",flexWrap:"wrap",marginBottom:12}}><label>Month<input type="month" required value={period} onChange={e=>setPeriod(e.target.value)}/></label><button disabled={busy}>{busy?"Loading…":"Show month"}</button></form>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {view&&<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:12,marginBottom:16}} data-staff-grid="split">
   <article style={box}><h3 style={{marginTop:0}}>GST payable (2130)</h3>{line("Owed at the start of the month",view.gst.opening)}{line("GST accrued this month",view.gst.accrued)}{line("GST paid this month",view.gst.paid)}{line("Owed at the end of the month",view.gst.closing)}{line("Service GST filed for the month",view.gst.filedServiceGst)}{line("Taxable value filed",view.gst.serviceTaxableValue)}{line("Exempt (funeral) value",view.gst.serviceExemptValue)}{line("GSTR-3B draft service GST",view.gst.latestGstr3bServiceGst)}{line("Payments recorded for the month",view.gst.paymentsRecordedForPeriod)}{line("Same bookings in the ledger",view.gst.sameBookings.agrees?"Agree":`Differ: ${money(view.gst.sameBookings.postedGst)} posted`)}<small style={{display:"block",marginTop:8,color:"var(--staff-muted)"}}>{view.gst.explanation}</small></article>
   <article style={box}><h3 style={{marginTop:0}}>TCS payable (2140)</h3>{line("Owed at the start of the month",view.tcs.opening)}{line("TCS withheld this month",view.tcs.accrued)}{line("TCS paid this month",view.tcs.paid)}{line("Owed at the end of the month",view.tcs.closing)}{line("TCS computed for GSTR-8",view.tcs.tcsCollections)}{line("GSTR-8 prepared",view.tcs.gstr8PreparedTcs)}{line("Deposit recorded",view.tcs.deposit?`${money(view.tcs.deposit.amount)} (${view.tcs.deposit.challanReference})`:"None yet")}{line("Bookings that differ",String(view.tcs.sameBookings.mismatches.length))}<small style={{display:"block",marginTop:8,color:"var(--staff-muted)"}}>{view.tcs.explanation}</small></article>
  </div>}
  {view&&<p><b>{view.status==="reconciled"?"The payables agree with the returns for this month.":"There are differences to review for this month."}</b></p>}
  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(320px,1fr))",gap:16}} data-staff-grid="split">
   <form onSubmit={e=>{e.preventDefault();void send({action:"record_tax_payment",taxKind,periodCode:period,amount:Number(amount),challanReference:challan,paidOn,reason},"Unable to record the tax payment",`${taxKind==="gst"?"GST":"TCS"} payment recorded against the bank`);}} style={{display:"grid",gap:10}}>
    <h3 style={{margin:0}}>Record tax paid for {period}</h3>
    <label>Tax<select value={taxKind} onChange={e=>setTaxKind(e.target.value)}><option value="gst">GST (GSTR-3B)</option><option value="tcs">TCS (GSTR-8)</option></select></label>
    <label>Amount paid<input type="number" min="0.01" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)}/></label>
    <label>Challan reference (CPIN / CIN)<input required minLength={4} value={challan} onChange={e=>setChallan(e.target.value)}/></label>
    <label>Paid on<input type="date" required value={paidOn} onChange={e=>setPaidOn(e.target.value)}/></label>
    <label>Reason<input required minLength={8} value={reason} onChange={e=>setReason(e.target.value)} placeholder="For example: September GSTR-3B paid"/></label>
    <button disabled={busy}>{busy?"Saving…":"Record payment"}</button>
   </form>
   <form onSubmit={e=>{e.preventDefault();void send({action:"assign_period_service_owner",periodCode:period,entityId,registrationId,reason:ownerReason},"Unable to assign the month's service supplies","Every unassigned service supply of the month is now assigned")}} style={{display:"grid",gap:10}}>
    <h3 style={{margin:0}}>Assign every service supply of {period}</h3>
    <p style={{margin:0,color:"var(--staff-muted)"}}>A month cannot be closed while a service invoice or completed service is unassigned, and a closed month can no longer be assigned.</p>
    <label>Legal entity<select required value={entityId} onChange={e=>{setEntityId(e.target.value);setRegistrationId("");}}><option value="">Choose entity</option>{entities.filter(row=>row.status==="active").map(row=><option key={String(row.id)} value={String(row.id)}>{String(row.legal_name)}</option>)}</select></label>
    <label>GST registration<select required value={registrationId} onChange={e=>setRegistrationId(e.target.value)}><option value="">Choose registration</option>{registrations.filter(row=>row.status==="active"&&row.entity_id===entityId).map(row=><option key={String(row.id)} value={String(row.id)}>{String(row.registration_reference)}</option>)}</select></label>
    <label>Ownership evidence<input required minLength={8} value={ownerReason} onChange={e=>setOwnerReason(e.target.value)} placeholder="Reference supporting this legal ownership"/></label>
    <button disabled={busy}>{busy?"Assigning…":"Assign the month"}</button>
   </form>
  </div>
 </section>;
}
