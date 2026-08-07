"use client";

import Link from"next/link";
import{useEffect,useState}from"react";

type LedgerItem=Record<string,unknown>;
type LedgerResponse={source:string;summary:{bookings:number;completed:number;invoiced:number;collected:number;receivable:number};items:LedgerItem[];error?:string};
const money=(value:unknown)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(Number(value||0));

export default function TeamFinance(){
  const[data,setData]=useState<LedgerResponse|null>(null);
  const[error,setError]=useState("");
  const[loading,setLoading]=useState(true);
  const load=async()=>{setLoading(true);setError("");try{const response=await fetch("/api/grooming-finance",{cache:"no-store"});const body=await response.json() as LedgerResponse;if(!response.ok)throw new Error(body.error||"Unable to load finance ledger");setData(body);}catch(err){setError(err instanceof Error?err.message:"Unable to load finance ledger");}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);

  return <main style={{minHeight:"100vh",background:"#f7f4fb",padding:"32px",fontFamily:"Arial, sans-serif",color:"#24133f"}}>
    <div style={{maxWidth:1320,margin:"0 auto"}}>
      <header style={{display:"flex",justifyContent:"space-between",gap:20,alignItems:"center",marginBottom:24}}>
        <div><small style={{fontWeight:800,letterSpacing:1.4,color:"#6c39a8"}}>PAWSPACE TEAM · FINANCE</small><h1 style={{fontSize:36,margin:"8px 0"}}>Grooming finance ledger</h1><p style={{margin:0,color:"#6d6379"}}>Booking → payment → invoice → reconciliation, projected from the canonical Grooming record.</p></div>
        <div style={{display:"flex",gap:10}}><button onClick={()=>void load()} style={{padding:"11px 16px",borderRadius:10,border:"1px solid #d9cde8",background:"white",fontWeight:700}}>Refresh</button><Link href="/team" style={{padding:"11px 16px",borderRadius:10,background:"#4b168c",color:"white",textDecoration:"none",fontWeight:700}}>Team home</Link></div>
      </header>

      {error&&<section style={{padding:18,borderRadius:12,background:"#fff1f1",border:"1px solid #efc2c2",marginBottom:20}}><b>Finance ledger unavailable</b><div>{error}</div></section>}
      {loading&&<section style={{padding:24,background:"white",borderRadius:14}}>Loading canonical Grooming ledger…</section>}
      {data&&!loading&&<>
        <section style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(0,1fr))",gap:12,marginBottom:22}}>
          {[["Bookings",data.summary.bookings],["Completed",data.summary.completed],["Invoiced",money(data.summary.invoiced)],["Collected",money(data.summary.collected)],["Receivable",money(data.summary.receivable)]].map(([label,value])=><article key={String(label)} style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,padding:18}}><small style={{color:"#746b7d"}}>{label}</small><strong style={{display:"block",fontSize:25,marginTop:7}}>{value}</strong></article>)}
        </section>
        <section style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,overflow:"hidden"}}>
          <div style={{padding:"16px 18px",borderBottom:"1px solid #eee6f5",display:"flex",justifyContent:"space-between"}}><b>Canonical transactions</b><small>{data.source}</small></div>
          <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:14}}><thead><tr>{["Booking","Package","Status","Payment","Invoice","Amount","Receivable","Subscription"].map(h=><th key={h} style={{textAlign:"left",padding:"12px 14px",background:"#faf8fc",borderBottom:"1px solid #eee6f5"}}>{h}</th>)}</tr></thead><tbody>
            {data.items.length===0&&<tr><td colSpan={8} style={{padding:30,textAlign:"center",color:"#746b7d"}}>No canonical Grooming bookings yet. Create one from the customer flow.</td></tr>}
            {data.items.map(item=><tr key={String(item.booking_id)}><td style={{padding:"12px 14px",borderBottom:"1px solid #f1edf5",fontWeight:700}}>{String(item.booking_id)}</td><td style={{padding:"12px 14px",borderBottom:"1px solid #f1edf5"}}>{String(item.package_name)}</td><td style={{padding:"12px 14px",borderBottom:"1px solid #f1edf5"}}>{String(item.booking_status).replaceAll("_"," ")}</td><td style={{padding:"12px 14px",borderBottom:"1px solid #f1edf5"}}>{String(item.payment_status).replaceAll("_"," ")}</td><td style={{padding:"12px 14px",borderBottom:"1px solid #f1edf5"}}>{item.invoice_number?String(item.invoice_number):"Pending completion"}</td><td style={{padding:"12px 14px",borderBottom:"1px solid #f1edf5"}}>{money(item.payment_amount)}</td><td style={{padding:"12px 14px",borderBottom:"1px solid #f1edf5"}}>{money(item.receivable)}</td><td style={{padding:"12px 14px",borderBottom:"1px solid #f1edf5"}}>{item.subscription_plan?`${String(item.subscription_plan)} · ${String(item.subscription_usage_status)}`:"—"}</td></tr>)}
          </tbody></table></div>
        </section>
        <p style={{fontSize:12,color:"#746b7d",marginTop:12}}>UAT ledger only. No live Razorpay, RazorpayX, GST filing or accounting export is activated by this screen.</p>
      </>}
    </div>
  </main>;
}
