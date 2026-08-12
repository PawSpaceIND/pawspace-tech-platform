"use client";
import Link from"next/link";
import{useEffect,useState}from"react";

type Enquiry={id:string;customerName:string;phonePrimary:string;phoneSecondary:string|null;email:string;petType:string;relocationKind?:string;pickupDate:string;pickupApproxTime:string;pickupLocation:string;dropLocation:string;expectedTravelDate:string;status:string;createdAt:number};

const box={background:"var(--ds-surface)",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-lg)",padding:16} as const;
const row={display:"grid",gridTemplateColumns:"1.2fr 1fr 1fr 1fr 1fr",gap:8,padding:"10px 0",borderBottom:"1px solid var(--ds-border)",fontSize:14} as const;

export default function TeamRelocationEnquiries(){
  const[rows,setRows]=useState<Enquiry[]>([]);
  const[error,setError]=useState("");
  const[loading,setLoading]=useState(true);

  useEffect(()=>{
    let live=true;
    fetch("/api/relocation-enquiry",{cache:"no-store"}).then(r=>r.json()).then(body=>{
      if(!live)return;
      if(body.error)setError(String(body.error));
      else setRows((body.data??[]) as Enquiry[]);
    }).catch(e=>{if(live)setError(e instanceof Error?e.message:"Unable to load relocation enquiries");}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[]);

  return <main style={{maxWidth:1100,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16}}>
    <header><Link href="/team">← Team</Link><p style={{color:"var(--ds-primary-500)",letterSpacing:1,fontSize:12}}>PET RELOCATION · ENQUIRIES</p><h1 style={{margin:0}}>Submitted relocation enquiries</h1><p>Customer-submitted pickup/drop enquiries, newest first. Sandbox/UAT — no live money.</p></header>
    {error&&<p role="alert" style={{color:"var(--ds-danger-500)"}}>{error}</p>}
    <section style={box}>
      <div style={{...row,fontWeight:700,color:"var(--ds-text-muted)"}}><span>Customer</span><span>Contact</span><span>Pet</span><span>Pickup</span><span>Drop → Travel</span></div>
      {loading&&<p>Loading…</p>}
      {!loading&&rows.length===0&&<p>No enquiries submitted yet.</p>}
      {rows.map(enquiry=><div key={enquiry.id} style={row}>
        <span>{enquiry.customerName}<br/><small>{enquiry.id}</small></span>
        <span>{enquiry.phonePrimary}{enquiry.phoneSecondary?<><br/><small>{enquiry.phoneSecondary}</small></>:null}<br/><small>{enquiry.email}</small></span>
        <span style={{textTransform:"capitalize"}}>{enquiry.petType} · {enquiry.relocationKind==="international"?"Intl":"Domestic"}</span>
        <span>{enquiry.pickupDate} {enquiry.pickupApproxTime}<br/><small>{enquiry.pickupLocation}</small></span>
        <span>{enquiry.dropLocation}<br/><small>Travel: {enquiry.expectedTravelDate}</small></span>
      </div>)}
    </section>
  </main>;
}
