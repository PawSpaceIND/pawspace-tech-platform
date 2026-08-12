"use client";
import{useEffect,useState}from"react";
import Link from"next/link";

type Booking={bookingId:string;serviceCode:string;package:string;start:string;status:string;orderValue:number;paymentStatus:string;paymentDueNow:number;paymentMethod:string|null};
type Offer={bookingId:string;serviceCode:string;package:string;start:string;orderValue:number};
type Pending={bookingId:string;serviceCode:string;missing:string[]};
type WS={linked:boolean;email?:string;engagement?:string;features?:{surface:string;payslip:boolean};onboardingStatus?:string;
  bookings?:{today:Booking[];upcoming:Booking[];past:Booking[];paymentPending:Booking[]};
  liveAssignments?:Offer[];earnings?:{netPayout?:number;orders?:number;grossOrderValue?:number;visible?:boolean};pendingProof?:Pending[]};

const INR=(v?:number)=>`₹${Number(v||0).toLocaleString("en-IN")}`;
const C={ink:"#FDF3E1",dim:"#b8c6c0",ground:"#01261F",panel:"#0b2b24",panel2:"#01261F",line:"#123c33",orange:"#F6920A",purple:"#8b6bd8",gold:"#E6B34E",green:"#3ecf8e"};
async function load(){const r=await fetch("/api/provider-workspace",{cache:"no-store"});const p=await r.json();if(!r.ok)throw new Error(p.error||"Load failed");return p.data as WS;}

export default function PartnerWorkspacePage(){
  const[data,setData]=useState<WS|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[msg,setMsg]=useState("");
  const refresh=async()=>{try{setData(await load());setError("");}catch(e){setError(e instanceof Error?e.message:String(e));}};
  useEffect(()=>{let active=true;void load().then(x=>{if(active){setData(x);setError("");}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  async function post(payload:Record<string,unknown>){const r=await fetch("/api/provider-workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});const b=await r.json() as{error?:string};if(!r.ok)throw new Error(b.error||"Failed");}
  async function act(payload:Record<string,unknown>,okMsg:string){setBusy(true);setMsg("");try{await post(payload);setMsg(okMsg);await refresh();}catch(e){setMsg(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}

  const card:React.CSSProperties={background:C.panel,border:`1px solid ${C.line}`,borderRadius:16,padding:18,marginTop:14};
  const h2:React.CSSProperties={fontSize:15,letterSpacing:1.5,textTransform:"uppercase",color:C.gold,margin:"0 0 12px"};
  const btn:React.CSSProperties={padding:"8px 14px",borderRadius:9,border:"none",background:C.orange,color:"#01261F",fontWeight:700,cursor:"pointer"};
  const chip=(t:string,c:string):React.CSSProperties=>({display:"inline-block",padding:"2px 9px",borderRadius:999,fontSize:12,background:c,color:t});
  const payColor=(s:string)=>s==="captured"||s==="paid"?C.green:["failed"].includes(s)?"#ff9a9a":C.gold;
  const row=(b:Booking)=><div key={b.bookingId} style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:`1px solid ${C.line}`,padding:"8px 0",flexWrap:"wrap",gap:6}}><span><b>{b.serviceCode}</b> · {b.package} <small style={{color:C.dim}}>{b.start.slice(0,16).replace("T"," ")}</small></span><span style={{display:"flex",gap:10,alignItems:"center"}}>{INR(b.orderValue)} <span style={chip(payColor(b.paymentStatus),"rgba(255,255,255,0.06)")}>{b.paymentStatus}</span></span></div>;

  return <main style={{minHeight:"100vh",background:C.ground,color:C.ink,fontFamily:"system-ui,-apple-system,Segoe UI,sans-serif"}}>
    <div style={{maxWidth:1000,margin:"0 auto",padding:"28px 20px 60px"}}>
      <p style={{margin:0}}><Link href="/partner" style={{color:C.dim,textDecoration:"none"}}>← Partner hub</Link></p>
      <p style={{fontWeight:800,letterSpacing:2,color:C.dim,fontSize:12,marginTop:10}}>PAWSPACE · PARTNER WORKSPACE</p>
      {error?<p style={{color:"#ff9a9a"}}>{error}</p>:null}
      {loading&&!data?<p style={{color:C.dim}}>Loading your workspace…</p>:null}
      {msg?<p style={{color:C.gold}}>{msg}</p>:null}

      {data&&!data.linked?<section style={card}><h1 style={{marginTop:0}}>No provider record linked</h1><p style={{color:C.dim}}>Your identity <b>{data.email}</b> is signed in but not yet linked to a provider profile. Ask PawSpace ops to link you, then your jobs, assignments and payments appear here.</p></section>:null}

      {data?.linked?<>
        <header style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:10,marginTop:8}}>
          <div><h1 style={{margin:"6px 0",fontSize:28}}>Partner workspace</h1>
            <p style={{margin:0,color:C.dim}}>{data.engagement==="contract"?"Contract partner":"Commission partner"} · onboarding: <b style={{color:data.onboardingStatus==="active"?C.green:C.gold}}>{data.onboardingStatus}</b></p></div>
          {data.features?.payslip?<Link href="/me" style={{...btn,textDecoration:"none",display:"inline-block"}}>Payslip & leave →</Link>:null}
        </header>

        {data.earnings?.visible!==false?<section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12,marginTop:16}}>
          <div style={{...card,marginTop:0}}><small style={{color:C.dim}}>Net payout (computed)</small><strong style={{display:"block",fontSize:24,marginTop:6,color:C.gold}}>{INR(data.earnings?.netPayout)}</strong></div>
          <div style={{...card,marginTop:0}}><small style={{color:C.dim}}>Orders</small><strong style={{display:"block",fontSize:24,marginTop:6}}>{data.earnings?.orders||0}</strong></div>
          <div style={{...card,marginTop:0}}><small style={{color:C.dim}}>Gross order value</small><strong style={{display:"block",fontSize:24,marginTop:6}}>{INR(data.earnings?.grossOrderValue)}</strong></div>
        </section>:null}

        <h2 style={{...h2,marginTop:24}}>Live assignments to accept</h2>
        <div style={card}>{data.liveAssignments?.length?data.liveAssignments.map(o=><div key={o.bookingId} style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:`1px solid ${C.line}`,padding:"8px 0",flexWrap:"wrap",gap:8}}>
          <span><b>{o.serviceCode}</b> · {o.package} <small style={{color:C.dim}}>{o.start.slice(0,16).replace("T"," ")}</small> · {INR(o.orderValue)}</span>
          <span style={{display:"flex",gap:8}}><button disabled={busy} style={{...btn,background:C.green}} onClick={()=>void act({action:"accept_job",bookingId:o.bookingId},"Job accepted.")}>Accept</button><button disabled={busy} style={{...btn,background:"transparent",color:C.dim,border:`1px solid ${C.line}`}} onClick={()=>void act({action:"decline_job",bookingId:o.bookingId},"Declined.")}>Decline</button></span>
        </div>):<p style={{color:C.dim,margin:0}}>No live assignments right now.</p>}</div>

        <h2 style={h2}>Payment pending</h2>
        <div style={card}>{data.bookings?.paymentPending.length?data.bookings.paymentPending.map(row):<p style={{color:C.dim,margin:0}}>No pending payments.</p>}</div>

        <h2 style={h2}>Upcoming</h2>
        <div style={card}>{data.bookings?.upcoming.length?data.bookings.upcoming.map(row):<p style={{color:C.dim,margin:0}}>Nothing upcoming.</p>}</div>

        <h2 style={h2}>Proof pending (customers are reminded until you post it)</h2>
        <div style={card}>{data.pendingProof?.length?data.pendingProof.map(p=><div key={p.bookingId} style={{borderBottom:`1px solid ${C.line}`,padding:"8px 0"}}>
          <div><b>{p.serviceCode}</b> · <code style={{color:C.dim}}>{p.bookingId}</code></div>
          <div style={{display:"flex",gap:8,marginTop:6,flexWrap:"wrap"}}>{p.missing.map(m=><button key={m} disabled={busy} style={{...btn,background:C.purple,color:C.ink,fontSize:12}} onClick={()=>void act({action:"submit_proof",bookingId:p.bookingId,proofType:m,objectId:`uat-${m}-${p.bookingId}`},`${m} posted; customer notified.`)}>Post {m.replace("_"," ")}</button>)}</div>
        </div>):<p style={{color:C.dim,margin:0}}>All proof up to date.</p>}</div>

        <h2 style={h2}>Recent jobs</h2>
        <div style={{...card,maxHeight:320,overflowY:"auto"}}>{data.bookings?.past.length?data.bookings.past.slice(0,25).map(row):<p style={{color:C.dim,margin:0}}>No past jobs.</p>}</div>

        <footer style={{marginTop:26,color:C.dim,fontSize:12}}>You see only your own jobs, offers, payments and earnings. Posting proof notifies the customer in their app. Sandbox / UAT — no live money.</footer>
      </>:null}
    </div>
  </main>;
}
