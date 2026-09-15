"use client";
import Link from"next/link";
import{useCallback,useEffect,useState}from"react";

type Enquiry={id:string;customerName:string;phonePrimary:string;phoneSecondary:string|null;email:string;petType:string;relocationKind?:string;pickupDate:string;pickupApproxTime:string;pickupLocation:string;dropLocation:string;expectedTravelDate:string;status:string;createdAt:number;revealed?:boolean;addressPrecision?:string};
type Payload={data?:Enquiry[];revealAvailable?:boolean;error?:string};

const box={background:"var(--ds-surface)",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-lg)",padding:16} as const;
const row={display:"grid",gridTemplateColumns:"1.2fr 1fr 1fr 1fr 1fr",gap:8,padding:"10px 0",borderBottom:"1px solid var(--ds-border)",fontSize:14} as const;
const reveal={background:"transparent",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-sm)",padding:"3px 8px",fontSize:11,cursor:"pointer",marginTop:4} as const;

export default function TeamRelocationEnquiries(){
  const[rows,setRows]=useState<Enquiry[]>([]);
  const[error,setError]=useState("");
  const[loading,setLoading]=useState(true);
  const[revealAvailable,setRevealAvailable]=useState(false);
  const[busy,setBusy]=useState("");

  const load=useCallback(async(query="")=>{
    const response=await fetch("/api/relocation-enquiry"+query,{cache:"no-store"});
    const body=await response.json() as Payload;
    if(body.error)throw new Error(String(body.error));
    setRows((body.data??[]) as Enquiry[]);
    setRevealAvailable(Boolean(body.revealAvailable));
  },[]);

  /* queueMicrotask, not a direct call: the first load must not put setState in the effect body
     (react-hooks/set-state-in-effect), the same shape app/assisted-booking/page.tsx uses. */
  useEffect(()=>{let live=true;
    queueMicrotask(()=>{if(live)void load().catch(e=>{if(live)setError(e instanceof Error?e.message:"Unable to load relocation enquiries");}).finally(()=>{if(live)setLoading(false);});});
    return()=>{live=false;};
  },[load]);

  /* One record, one stated reason - the reveal the platform approves. The list itself never carries
   * raw contact details, so this is the only way a real number reaches this screen. */
  async function revealOne(id:string){
    const reason=window.prompt("Why do you need this customer's contact details? (recorded against your name)")||"";
    if(reason.trim().length<5){setError("A reveal needs a reason of at least 5 characters");return;}
    setError("");setBusy(id);
    try{await load(`?reveal=${encodeURIComponent(id)}&reason=${encodeURIComponent(reason.trim())}`);}
    catch(e){setError(e instanceof Error?e.message:"Unable to reveal this enquiry");}
    finally{setBusy("");}
  }

  return <main style={{maxWidth:1100,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16}}>
    <header><Link href="/team">← Team</Link><p style={{color:"var(--ds-primary-500)",letterSpacing:1,fontSize:12}}>PET RELOCATION · ENQUIRIES</p><h1 style={{margin:0}}>Submitted relocation enquiries</h1><p>Customer-submitted pickup/drop enquiries, newest first. Contact details and addresses are masked; reveal one record at a time with a reason. Sandbox/UAT — no live money.</p></header>
    {error&&<p role="alert" style={{color:"var(--ds-danger-500)"}}>{error}</p>}
    <section style={box}>
      <div style={{...row,fontWeight:700,color:"var(--ds-text-muted)"}}><span>Customer</span><span>Contact</span><span>Pet</span><span>Pickup</span><span>Drop → Travel</span></div>
      {loading&&<p>Loading…</p>}
      {!loading&&rows.length===0&&<p>No enquiries submitted yet.</p>}
      {rows.map(enquiry=><div key={enquiry.id} style={row}>
        <span>{enquiry.customerName}<br/><small>{enquiry.id}</small></span>
        <span>{enquiry.phonePrimary}{enquiry.phoneSecondary?<><br/><small>{enquiry.phoneSecondary}</small></>:null}<br/><small>{enquiry.email}</small>
          {revealAvailable&&!enquiry.revealed?<><br/><button type="button" style={reveal} disabled={busy===enquiry.id} onClick={()=>void revealOne(enquiry.id)}>{busy===enquiry.id?"Revealing…":"Reveal contact"}</button></>:null}
          {enquiry.revealed?<><br/><small style={{color:"var(--ds-primary-500)"}}>Revealed · recorded</small></>:null}</span>
        <span style={{textTransform:"capitalize"}}>{enquiry.petType} · {enquiry.relocationKind==="international"?"Intl":"Domestic"}</span>
        <span>{enquiry.pickupDate} {enquiry.pickupApproxTime}<br/><small>{enquiry.pickupLocation}</small></span>
        <span>{enquiry.dropLocation}<br/><small>Travel: {enquiry.expectedTravelDate}</small></span>
      </div>)}
    </section>
  </main>;
}
