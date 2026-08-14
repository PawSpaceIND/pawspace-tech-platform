"use client";
import Link from"next/link";
import{useState}from"react";

type EnquiryResult={id:string;customerName:string;pickupDate:string;expectedTravelDate:string};
type FormState={customerName:string;phonePrimary:string;phoneSecondary:string;email:string;petType:"dog"|"cat";relocationKind:"domestic"|"international";pickupDate:string;pickupApproxTime:string;pickupLocation:string;dropLocation:string;expectedTravelDate:string};

const empty:FormState={customerName:"",phonePrimary:"",phoneSecondary:"",email:"",petType:"dog",relocationKind:"domestic",pickupDate:"",pickupApproxTime:"",pickupLocation:"",dropLocation:"",expectedTravelDate:""};

const page={maxWidth:640,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16} as const;
const hero={background:"var(--ds-primary-500)",color:"#fff",borderRadius:"var(--ds-radius-lg)",padding:"24px 22px",display:"grid",gap:8} as const;
const box={background:"var(--ds-surface)",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-lg)",padding:18,display:"grid",gap:14} as const;
const label={display:"grid",gap:4,fontSize:14,color:"var(--ds-text)"} as const;
const input={padding:"10px 12px",borderRadius:"var(--ds-radius-sm)",border:"1px solid var(--ds-border)",fontSize:15} as const;
const button={background:"var(--ds-accent-500)",color:"var(--ds-primary-600)",border:"none",borderRadius:"var(--ds-radius-sm)",padding:"12px 20px",fontWeight:700,fontSize:15,cursor:"pointer"} as const;

export default function RelocationEnquiryPage(){
  const[form,setForm]=useState<FormState>(empty);
  const[result,setResult]=useState<EnquiryResult|null>(null);
  const[error,setError]=useState("");
  const[busy,setBusy]=useState(false);
  const set=(key:keyof FormState,value:string)=>setForm(current=>({...current,[key]:value}));

  async function submit(){
    setError("");setBusy(true);
    try{
      const r=await fetch("/api/relocation-enquiry",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...form,phoneSecondary:form.phoneSecondary||undefined})});
      const body=await r.json() as{data?:EnquiryResult;error?:string};
      if(!r.ok||!body.data)throw new Error(body.error||"Unable to submit relocation enquiry");
      setResult(body.data);
    }catch(e){setError(e instanceof Error?e.message:"Unable to submit relocation enquiry");}
    finally{setBusy(false);}
  }

  if(result)return <main style={page}>
    <header style={hero}><p style={{margin:0,letterSpacing:1,fontSize:12,color:"var(--ds-accent-500)"}}>PET RELOCATION · ENQUIRY RECEIVED</p><h1 style={{margin:0}}>Thanks, {result.customerName}!</h1><p style={{margin:0}}>Your enquiry <strong>{result.id}</strong> has been logged. Our relocation team will call you to confirm pickup on {result.pickupDate} and plan travel for {result.expectedTravelDate}.</p></header>
    <p><Link href="/">← Back to PawSpace</Link></p>
  </main>;

  return <main style={page}>
    <header style={hero}>
      <p style={{margin:0,letterSpacing:1,fontSize:12,color:"var(--ds-accent-500)"}}>PET RELOCATION · ENQUIRY</p>
      <h1 style={{margin:0}}>Moving with your pet? Tell us the details.</h1>
      <p style={{margin:0,opacity:.9}}>Share your contact and pickup/drop details — our team will reach out to plan the relocation. Sandbox/UAT: no payment is taken here.</p>
    </header>
    {error&&<p role="alert" style={{color:"var(--ds-danger-500)"}}>{error}</p>}
    <section style={box}>
      <label style={label}>Customer name<input style={input} value={form.customerName} onChange={e=>set("customerName",e.target.value)} placeholder="Full name"/></label>
      <label style={label}>Primary phone (10 digits)<input style={input} value={form.phonePrimary} onChange={e=>set("phonePrimary",e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="9876543210" inputMode="numeric"/></label>
      <label style={label}>Secondary phone (optional)<input style={input} value={form.phoneSecondary} onChange={e=>set("phoneSecondary",e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="Optional" inputMode="numeric"/></label>
      <label style={label}>Email<input style={input} type="email" value={form.email} onChange={e=>set("email",e.target.value)} placeholder="you@example.com"/></label>
      <label style={label}>Pet type<select style={input} value={form.petType} onChange={e=>set("petType",e.target.value as"dog"|"cat")}><option value="dog">Dog</option><option value="cat">Cat</option></select></label>
      <label style={label}>Relocation type<select style={input} value={form.relocationKind} onChange={e=>set("relocationKind",e.target.value as"domestic"|"international")}><option value="domestic">Domestic within India</option><option value="international">International</option></select></label>
      <label style={label}>Pickup date<input style={input} type="date" value={form.pickupDate} onChange={e=>set("pickupDate",e.target.value)}/></label>
      <label style={label}>Pickup approximate time<input style={input} type="time" value={form.pickupApproxTime} onChange={e=>set("pickupApproxTime",e.target.value)}/></label>
      <label style={label}>Pickup location<input style={input} value={form.pickupLocation} onChange={e=>set("pickupLocation",e.target.value)} placeholder="Address / area, city"/></label>
      <label style={label}>Drop location<input style={input} value={form.dropLocation} onChange={e=>set("dropLocation",e.target.value)} placeholder="Address / area, city"/></label>
      <label style={label}>Expected travel date<input style={input} type="date" value={form.expectedTravelDate} onChange={e=>set("expectedTravelDate",e.target.value)}/></label>
      <div><button style={button} disabled={busy} onClick={()=>void submit()}>{busy?"Submitting…":"Submit enquiry"}</button></div>
    </section>
    <p><Link href="/">← Back to PawSpace</Link></p>
  </main>;
}
