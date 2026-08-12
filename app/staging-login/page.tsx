"use client";
import{useEffect,useState}from"react";

const C={ink:"#FDF3E1",dim:"#b8c6c0",ground:"#01261F",panel:"#0b2b24",line:"#123c33",orange:"#F6920A",gold:"#E6B34E",green:"#3ecf8e"};
// Seeded identities a tester can jump in as. Any other email works too (gets full/founder access for UAT).
const QUICK=[
  {label:"Founder (full access)",email:"founder@pawspace.in"},
  {label:"Finance (payroll, GST, payouts)",email:"anjali.finance33@tkpetcare.in"},
  {label:"Manager (people & performance)",email:"jyoti.manager39@tkpetcare.in"},
  {label:"Employee — groomer (self-service)",email:"asha.groomer1@tkpetcare.in"},
  {label:"Employee — sales associate",email:"anita.associate17@tkpetcare.in"},
];

export default function StagingLoginPage(){
  const[enabled,setEnabled]=useState<boolean|null>(null),[signedIn,setSignedIn]=useState<string|null>(null);
  const[code,setCode]=useState(""),[email,setEmail]=useState(""),[busy,setBusy]=useState(false),[msg,setMsg]=useState("");
  useEffect(()=>{let a=true;void fetch("/api/staging-login",{cache:"no-store"}).then(r=>r.json().then(j=>({ok:r.ok,j}))).then(({ok,j})=>{if(!a)return;setEnabled(ok&&j.enabled);setSignedIn(j?.signedInAs?.email||null);}).catch(()=>{if(a)setEnabled(false);});return()=>{a=false;};},[]);

  async function login(useEmail:string){
    if(!code.trim()){setMsg("Enter the access code first.");return;}
    if(!useEmail.trim()){setMsg("Pick an identity or type an email.");return;}
    setBusy(true);setMsg("");
    try{const r=await fetch("/api/staging-login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:code.trim(),email:useEmail.trim()})});
      const j=await r.json() as{error?:string;email?:string};
      if(!r.ok)throw new Error(j.error||"Sign-in failed");
      window.location.assign("/me");
    }catch(e){setMsg(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function logout(){setBusy(true);try{await fetch("/api/staging-login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"logout"})});setSignedIn(null);setMsg("Signed out.");}finally{setBusy(false);}}

  const card:React.CSSProperties={background:C.panel,border:`1px solid ${C.line}`,borderRadius:16,padding:22,maxWidth:520,margin:"0 auto"};
  const inp:React.CSSProperties={display:"block",width:"100%",padding:11,marginTop:6,borderRadius:9,border:`1px solid ${C.line}`,background:C.ground,color:C.ink,boxSizing:"border-box"};
  const btn:React.CSSProperties={padding:"11px 16px",borderRadius:10,border:"none",background:C.orange,color:"#01261F",fontWeight:700,cursor:"pointer"};

  return <main style={{minHeight:"100vh",background:C.ground,color:C.ink,fontFamily:"system-ui,-apple-system,Segoe UI,sans-serif",display:"flex",alignItems:"center",padding:"40px 20px"}}>
    <div style={{width:"100%"}}>
      <p style={{textAlign:"center",fontWeight:800,letterSpacing:2,color:C.dim,fontSize:12}}>PAWSPACE · STAGING UAT SIGN-IN</p>
      <div style={card}>
        {enabled===false?<p style={{color:"#ff9a9a",margin:0}}>UAT sign-in is not enabled on this environment.</p>:null}
        {enabled===null?<p style={{color:C.dim,margin:0}}>Checking…</p>:null}
        {enabled?<>
          {signedIn?<p style={{color:C.green}}>Signed in as <b>{signedIn}</b>. <a href="/me" style={{color:C.gold}}>Go to my workspace →</a> · <button onClick={()=>void logout()} disabled={busy} style={{background:"none",border:"none",color:C.dim,cursor:"pointer",textDecoration:"underline"}}>sign out</button></p>:null}
          <label style={{fontSize:13,color:C.dim}}>Access code<input style={inp} value={code} type="password" placeholder="shared UAT access code" onChange={e=>setCode(e.target.value)}/></label>
          <p style={{fontSize:13,color:C.dim,margin:"16px 0 6px"}}>Jump in as a seeded identity:</p>
          <div style={{display:"grid",gap:8}}>{QUICK.map(q=><button key={q.email} disabled={busy} onClick={()=>void login(q.email)} style={{...btn,background:"transparent",color:C.ink,border:`1px solid ${C.line}`,textAlign:"left"}}><b>{q.label}</b><br/><small style={{color:C.dim}}>{q.email}</small></button>)}</div>
          <p style={{fontSize:13,color:C.dim,margin:"16px 0 6px"}}>…or any email (gets full access for testing):</p>
          <div style={{display:"flex",gap:8}}><input style={{...inp,marginTop:0}} value={email} placeholder="you@example.com" onChange={e=>setEmail(e.target.value)}/><button disabled={busy} style={btn} onClick={()=>void login(email)}>{busy?"…":"Sign in"}</button></div>
          {msg?<p style={{color:msg.includes("out")?C.green:"#ff9a9a",marginTop:12}}>{msg}</p>:null}
          <p style={{fontSize:12,color:C.dim,marginTop:18}}>Staging only · synthetic test data · sandbox payments. This sign-in does not exist on production.</p>
        </>:null}
      </div>
    </div>
  </main>;
}
