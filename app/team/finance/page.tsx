"use client";
import VisualAnalytics from "../../components/ui/VisualAnalytics";

import Link from"next/link";
import{readReportJson}from"../../../lib/read-report-json";
import{useEffect,useState}from"react";
import StaffModule from "../../components/staff-workspace/StaffModule";
import GroomingGstPanel from "./grooming-gst-panel";

type LedgerItem=Record<string,unknown>;
type LedgerResponse={source:string;summary:{bookings:number;completed:number;invoiced:number;collected:number;refunded:number;receivable:number;reconciled:number;unreconciled:number;exceptions:number};items:LedgerItem[];reconciliationExceptions?:LedgerItem[];error?:string};
const money=(value:unknown)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(Number(value||0));
const label=(value:unknown)=>String(value||"not started").replaceAll("_"," ");

export default function TeamFinance(){
  const[data,setData]=useState<LedgerResponse|null>(null);
  const[error,setError]=useState("");
  const[loading,setLoading]=useState(true);
  const load=async()=>{setLoading(true);setError("");setData(null);try{const body=await readReportJson<LedgerResponse>("/api/grooming-finance");if(!body.summary||!Array.isArray(body.items))throw new Error("Finance ledger response is incomplete");setData(body);}catch(err){setError(err instanceof Error?err.message:"Unable to load finance ledger");}finally{setLoading(false);}};
  useEffect(()=>{let active=true;readReportJson<LedgerResponse>("/api/grooming-finance").then(body=>{if(!body.summary||!Array.isArray(body.items))throw new Error("Finance ledger response is incomplete");if(active)setData(body);}).catch(err=>{if(active)setError(err instanceof Error?err.message:"Unable to load finance ledger");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);

  return <StaffModule><main style={{minHeight:"100vh",background:"var(--staff-bg)",padding:"32px",fontFamily:"inherit",color:"var(--staff-text)"}}>
    <div style={{maxWidth:1420,margin:"0 auto"}}>
      <header style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:20,alignItems:"center",marginBottom:24}}>
        <div><small style={{fontWeight:800,letterSpacing:1.4,color:"var(--staff-primary)"}}>PAWSPACE TEAM · FINANCE</small><h1 style={{fontSize:32,margin:"8px 0"}}>Service finance & reconciliation</h1><p style={{margin:0,color:"var(--staff-muted)"}}>Canonical service ledgers, reconciliation, invoices and settlement readiness from one Team Finance shell.</p></div>
        <div style={{display:"flex",flexWrap:"wrap",gap:10}}><button disabled={loading} onClick={()=>void load()} style={{padding:"11px 16px",borderRadius:10,border:"1px solid var(--staff-line)",background:"var(--staff-surface)",fontWeight:700}}>Refresh</button><Link href="/team/finance/cash-flow" style={{padding:"11px 16px",borderRadius:10,border:"1px solid var(--staff-line)",background:"var(--staff-surface)",fontWeight:700,textDecoration:"none",color:"var(--staff-primary)"}}>Cash flow & earned revenue</Link><Link href="/team/finance/training" style={{padding:"11px 16px",borderRadius:10,border:"1px solid var(--staff-line)",background:"var(--staff-surface)",fontWeight:700,textDecoration:"none",color:"var(--staff-primary)"}}>Training finance</Link><Link href="/team/finance/boarding" style={{padding:"11px 16px",borderRadius:10,border:"1px solid var(--staff-line)",background:"var(--staff-surface)",fontWeight:700,textDecoration:"none",color:"var(--staff-primary)"}}>Boarding finance</Link><Link href="/team" style={{padding:"11px 16px",borderRadius:10,background:"var(--staff-primary)",color:"var(--staff-on-primary)",textDecoration:"none",fontWeight:700}}>Team home</Link></div>
      </header>

      <GroomingGstPanel />
      {error&&<section style={{padding:18,borderRadius:12,background:"var(--staff-danger-bg)",border:"1px solid var(--staff-line)",marginBottom:20}}><b>Finance ledger unavailable</b><div>{error}</div></section>}
      {loading&&<section style={{padding:24,background:"var(--staff-surface)",borderRadius:14}}>Loading canonical Grooming ledger…</section>}
      <VisualAnalytics serviceCode="grooming" title="Grooming revenue trends" />
      {data&&!loading&&!error&&<>
        <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12,marginBottom:12}} data-staff-grid="stats">
          {[["Bookings",data.summary.bookings],["Reconciled",data.summary.reconciled],["Unreconciled",data.summary.unreconciled],["Open exceptions",data.summary.exceptions]].map(([name,value])=><article key={String(name)} style={{background:"var(--staff-surface)",border:"1px solid var(--staff-line)",borderRadius:14,padding:18}}><small style={{color:"var(--staff-muted)"}}>{name}</small><strong style={{display:"block",fontSize:25,marginTop:7}}>{value}</strong></article>)}
        </section>
        <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12,marginBottom:22}} data-staff-grid="stats">
          {[["Completed",data.summary.completed],["Invoiced",money(data.summary.invoiced)],["Captured",money(data.summary.collected)],["Refunded",money(data.summary.refunded)],["Receivable",money(data.summary.receivable)]].map(([name,value])=><article key={String(name)} style={{background:"var(--staff-surface)",border:"1px solid var(--staff-line)",borderRadius:14,padding:18}}><small style={{color:"var(--staff-muted)"}}>{name}</small><strong style={{display:"block",fontSize:23,marginTop:7}}>{value}</strong></article>)}
        </section>
        {Number(data.summary.exceptions)>0&&<section style={{padding:16,borderRadius:12,background:"var(--staff-warning-bg)",border:"1px solid var(--staff-line)",marginBottom:18}}><b>{data.summary.exceptions} payment reconciliation exception(s) require Finance review.</b><div style={{fontSize:15,marginTop:5}}>Amount/currency mismatch, unmatched gateway event, orphan refund, refund failure or refund overage must be cleared before production reconciliation sign-off.</div></section>}
        <section style={{background:"var(--staff-surface)",border:"1px solid var(--staff-line)",borderRadius:14,overflow:"hidden"}}>
          <div style={{padding:"16px 18px",borderBottom:"1px solid var(--staff-line)",display:"flex",justifyContent:"space-between"}}><b>Canonical transactions</b><small>{data.source}</small></div>
          <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:15}}><thead><tr>{["Booking","Package","Booking","Payment","Gateway","Reconciliation","Captured","Refunded","Variance","Invoice","Subscription"].map(h=><th key={h} style={{textAlign:"left",padding:"12px 12px",background:"var(--staff-raised)",borderBottom:"1px solid var(--staff-line)",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead><tbody>
            {data.items.length===0&&<tr><td colSpan={11} style={{padding:30,textAlign:"center",color:"var(--staff-muted)"}}>No canonical Grooming bookings yet. Create one from the customer flow.</td></tr>}
            {data.items.map((item,index)=><tr key={`${String(item.booking_id)}:${index}`}><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)",fontWeight:700,whiteSpace:"nowrap"}}>{String(item.booking_id)}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}>{String(item.package_name)}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}>{label(item.booking_status)}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}>{label(item.payment_status)}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}>{label(item.gateway_status)}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}><strong>{label(item.reconciliation_status)}</strong>{Number(item.open_reconciliation_exceptions||0)>0&&<small style={{display:"block",marginTop:3}}>{Number(item.open_reconciliation_exceptions)} exception(s)</small>}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}>{money(item.captured_amount)}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}>{money(item.refunded_amount)}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}>{money(item.variance_amount)}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}>{item.invoice_number?String(item.invoice_number):"Pending"}</td><td style={{padding:"12px",borderBottom:"1px solid var(--staff-line)"}}>{item.subscription_plan?`${String(item.subscription_plan)} · ${label(item.subscription_usage_status)}`:"—"}</td></tr>)}
          </tbody></table></div>
        </section>
        <p style={{fontSize:14,color:"var(--staff-muted)",marginTop:12}}>UAT/sandbox only. Razorpay production credentials, live refunds, RazorpayX payouts, GST filing and accounting export are not activated by this screen.</p>
      </>}
    </div>
  <p><a href="/team/finance/walking">Open Dog Walking Finance workspace →</a></p></main></StaffModule>;
}
