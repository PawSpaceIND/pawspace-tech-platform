"use client";

import Link from"next/link";
import{useEffect,useState}from"react";

type LedgerItem=Record<string,unknown>;
type LedgerResponse={source:string;summary:{bookings:number;completed:number;invoiced:number;collected:number;refunded:number;receivable:number;reconciled:number;unreconciled:number;exceptions:number};items:LedgerItem[];reconciliationExceptions?:LedgerItem[];error?:string};
const money=(value:unknown)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(Number(value||0));
const label=(value:unknown)=>String(value||"not started").replaceAll("_"," ");

export default function TeamFinance(){
  const[data,setData]=useState<LedgerResponse|null>(null);
  const[error,setError]=useState("");
  const[loading,setLoading]=useState(true);
  const load=async()=>{setLoading(true);setError("");try{const response=await fetch("/api/grooming-finance",{cache:"no-store"});const body=await response.json() as LedgerResponse;if(!response.ok)throw new Error(body.error||"Unable to load finance ledger");setData(body);}catch(err){setError(err instanceof Error?err.message:"Unable to load finance ledger");}finally{setLoading(false);}};
  useEffect(()=>{let active=true;fetch("/api/grooming-finance",{cache:"no-store"}).then(async response=>{const body=await response.json() as LedgerResponse;if(!response.ok)throw new Error(body.error||"Unable to load finance ledger");if(active)setData(body);}).catch(err=>{if(active)setError(err instanceof Error?err.message:"Unable to load finance ledger");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);

  return <main style={{minHeight:"100vh",background:"#f7f4fb",padding:"32px",fontFamily:"Arial, sans-serif",color:"#24133f"}}>
    <div style={{maxWidth:1420,margin:"0 auto"}}>
      <header style={{display:"flex",justifyContent:"space-between",gap:20,alignItems:"center",marginBottom:24}}>
        <div><small style={{fontWeight:800,letterSpacing:1.4,color:"#6c39a8"}}>PAWSPACE TEAM · FINANCE</small><h1 style={{fontSize:36,margin:"8px 0"}}>Service finance & reconciliation</h1><p style={{margin:0,color:"#6d6379"}}>Canonical service ledgers, reconciliation, invoices and settlement readiness from one Team Finance shell.</p></div>
        <div style={{display:"flex",gap:10}}><button onClick={()=>void load()} style={{padding:"11px 16px",borderRadius:10,border:"1px solid #d9cde8",background:"white",fontWeight:700}}>Refresh</button><Link href="/team/finance/training" style={{padding:"11px 16px",borderRadius:10,border:"1px solid #d9cde8",background:"white",fontWeight:700,textDecoration:"none",color:"#4b168c"}}>Training finance</Link><Link href="/team" style={{padding:"11px 16px",borderRadius:10,background:"#4b168c",color:"white",textDecoration:"none",fontWeight:700}}>Team home</Link></div>
      </header>

      {error&&<section style={{padding:18,borderRadius:12,background:"#fff1f1",border:"1px solid #efc2c2",marginBottom:20}}><b>Finance ledger unavailable</b><div>{error}</div></section>}
      {loading&&<section style={{padding:24,background:"white",borderRadius:14}}>Loading canonical Grooming ledger…</section>}
      {data&&!loading&&<>
        <section style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:12,marginBottom:12}}>
          {[["Bookings",data.summary.bookings],["Reconciled",data.summary.reconciled],["Unreconciled",data.summary.unreconciled],["Open exceptions",data.summary.exceptions]].map(([name,value])=><article key={String(name)} style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,padding:18}}><small style={{color:"#746b7d"}}>{name}</small><strong style={{display:"block",fontSize:25,marginTop:7}}>{value}</strong></article>)}
        </section>
        <section style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(0,1fr))",gap:12,marginBottom:22}}>
          {[["Completed",data.summary.completed],["Invoiced",money(data.summary.invoiced)],["Captured",money(data.summary.collected)],["Refunded",money(data.summary.refunded)],["Receivable",money(data.summary.receivable)]].map(([name,value])=><article key={String(name)} style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,padding:18}}><small style={{color:"#746b7d"}}>{name}</small><strong style={{display:"block",fontSize:23,marginTop:7}}>{value}</strong></article>)}
        </section>
        {Number(data.summary.exceptions)>0&&<section style={{padding:16,borderRadius:12,background:"#fff7e8",border:"1px solid #efd4a5",marginBottom:18}}><b>{data.summary.exceptions} payment reconciliation exception(s) require Finance review.</b><div style={{fontSize:13,marginTop:5}}>Amount/currency mismatch, unmatched gateway event, orphan refund, refund failure or refund overage must be cleared before production reconciliation sign-off.</div></section>}
        <section style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,overflow:"hidden"}}>
          <div style={{padding:"16px 18px",borderBottom:"1px solid #eee6f5",display:"flex",justifyContent:"space-between"}}><b>Canonical transactions</b><small>{data.source}</small></div>
          <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr>{["Booking","Package","Booking","Payment","Gateway","Reconciliation","Captured","Refunded","Variance","Invoice","Subscription"].map(h=><th key={h} style={{textAlign:"left",padding:"12px 12px",background:"#faf8fc",borderBottom:"1px solid #eee6f5",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead><tbody>
            {data.items.length===0&&<tr><td colSpan={11} style={{padding:30,textAlign:"center",color:"#746b7d"}}>No canonical Grooming bookings yet. Create one from the customer flow.</td></tr>}
            {data.items.map(item=><tr key={String(item.booking_id)}><td style={{padding:"12px",borderBottom:"1px solid #f1edf5",fontWeight:700,whiteSpace:"nowrap"}}>{String(item.booking_id)}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}>{String(item.package_name)}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}>{label(item.booking_status)}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}>{label(item.payment_status)}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}>{label(item.gateway_status)}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}><strong>{label(item.reconciliation_status)}</strong>{Number(item.open_reconciliation_exceptions||0)>0&&<small style={{display:"block",marginTop:3}}>{Number(item.open_reconciliation_exceptions)} exception(s)</small>}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}>{money(item.captured_amount)}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}>{money(item.refunded_amount)}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}>{money(item.variance_amount)}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}>{item.invoice_number?String(item.invoice_number):"Pending"}</td><td style={{padding:"12px",borderBottom:"1px solid #f1edf5"}}>{item.subscription_plan?`${String(item.subscription_plan)} · ${label(item.subscription_usage_status)}`:"—"}</td></tr>)}
          </tbody></table></div>
        </section>
        <p style={{fontSize:12,color:"#746b7d",marginTop:12}}>UAT/sandbox only. Razorpay production credentials, live refunds, RazorpayX payouts, GST filing and accounting export are not activated by this screen.</p>
      </>}
    </div>
  <p><a href="/team/finance/walking">Open Dog Walking Finance workspace -></a></p></main>;
}
