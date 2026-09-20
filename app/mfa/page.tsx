"use client";

import Link from"next/link";
import{useEffect,useState}from"react";
import{useQueryParameter}from"../../lib/use-query-parameter";

type Enrollment={secret:string;otpauthUri:string;enabled:boolean};
type Phase="checking"|"enroll"|"verify"|"done"|"error";
const C={ink:"#FDF3E1",dim:"#b8c6c0",ground:"#01261F",panel:"#0b2b24",line:"#123c33",orange:"#F6920A",gold:"#E6B34E",green:"#3ecf8e"};

function safeNext(value:string){
 const target=value||"/team";
 return target.startsWith("/")&&!target.startsWith("//")?target:"/team";
}

export default function MfaPage(){
 const[phase,setPhase]=useState<Phase>("checking"),[enrollment,setEnrollment]=useState<Enrollment|null>(null),[code,setCode]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const next=safeNext(useQueryParameter("next"));
 const card:React.CSSProperties={background:C.panel,border:`1px solid ${C.line}`,borderRadius:18,padding:24,maxWidth:620,margin:"0 auto"};
 const input:React.CSSProperties={display:"block",width:"100%",padding:12,marginTop:7,borderRadius:10,border:`1px solid ${C.line}`,background:C.ground,color:C.ink,boxSizing:"border-box",fontSize:18,letterSpacing:4};
 const button:React.CSSProperties={padding:"11px 16px",borderRadius:10,border:"none",background:C.orange,color:C.ground,fontWeight:800,cursor:"pointer"};

 useEffect(()=>{let active=true;void(async()=>{
  try{
   const r=await fetch("/api/v1/auth/mfa/enroll",{method:"POST",headers:{"content-type":"application/json"},body:"{}",cache:"no-store"});
   const body=await r.json() as{data?:Enrollment;error?:string};
   if(!active)return;
   if(r.status===201&&body.data){setEnrollment(body.data);setPhase("enroll");return;}
   if(r.status===409&&/already enrolled/i.test(body.error||"")){setPhase("verify");return;}
   throw new Error(body.error||`MFA setup failed (HTTP ${r.status})`);
  }catch(error){if(active){setMessage(error instanceof Error?error.message:"Unable to start MFA");setPhase("error");}}
 })();return()=>{active=false};},[]);

 async function verifyAndContinue(value:string){
  const r=await fetch("/api/v1/auth/mfa/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:value}),cache:"no-store"});
  const body=await r.json().catch(()=>({})) as{error?:string};
  if(!r.ok)throw new Error(body.error||"MFA verification failed");
  setPhase("done");setMessage("MFA verified. Opening your workspace…");
  window.location.assign(next);
 }

 async function submit(){
  const value=code.replace(/\D/g,"");
  if(value.length!==6){setMessage("Enter the current 6-digit code from your authenticator app.");return;}
  setBusy(true);setMessage("");
  try{
   if(phase==="enroll"){
    const r=await fetch("/api/v1/auth/mfa/enroll",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:value}),cache:"no-store"});
    const body=await r.json().catch(()=>({})) as{data?:{enabled?:boolean};error?:string};
    if(!r.ok||body.data?.enabled!==true)throw new Error(body.error||"MFA enrollment could not be completed");
    try{await verifyAndContinue(value);return;}catch{setPhase("verify");setCode("");setMessage("MFA is enrolled. Enter a fresh authenticator code to continue.");return;}
   }
   await verifyAndContinue(value);
  }catch(error){setMessage(error instanceof Error?error.message:"MFA verification failed");}finally{setBusy(false);}
 }

 async function copySecret(){if(!enrollment?.secret)return;try{await navigator.clipboard.writeText(enrollment.secret);setMessage("Setup secret copied.");}catch{setMessage("Copy is unavailable in this browser. Select the setup secret manually.");}}

 return <main style={{minHeight:"100vh",background:C.ground,color:C.ink,fontFamily:"system-ui,-apple-system,Segoe UI,sans-serif",padding:"44px 20px"}}>
  <div style={{maxWidth:720,margin:"0 auto"}}>
   <p style={{fontWeight:800,letterSpacing:2,color:C.dim,fontSize:12,textAlign:"center"}}>PAWSPACE · PRIVILEGED STAFF SECURITY</p>
   <section style={card}>
    <h1 style={{marginTop:0}}>Multi-factor authentication</h1>
    <p style={{color:C.dim}}>Finance and other privileged roles must complete a second factor before protected money, payout and administration actions become available.</p>
    {phase==="checking"?<p style={{color:C.gold}}>Checking your MFA status…</p>:null}
    {phase==="enroll"&&enrollment?<>
      <h2 style={{fontSize:18}}>1. Add PawSpace to your authenticator</h2>
      <p style={{color:C.dim}}>Open Google Authenticator, Microsoft Authenticator, 1Password or another TOTP app and add this setup secret. It is shown only as part of your authenticated enrollment flow.</p>
      <div style={{background:C.ground,border:`1px solid ${C.line}`,borderRadius:12,padding:14,overflowWrap:"anywhere"}}><small style={{color:C.dim}}>Setup secret</small><strong style={{display:"block",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",fontSize:18,letterSpacing:2,marginTop:5}}>{enrollment.secret}</strong></div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:12}}><button type="button" style={{...button,background:C.gold}} onClick={()=>void copySecret()}>Copy setup secret</button><a href={enrollment.otpauthUri} style={{...button,textDecoration:"none",display:"inline-block"}}>Open authenticator</a></div>
      <h2 style={{fontSize:18,marginTop:24}}>2. Confirm the current code</h2>
    </>:null}
    {phase==="verify"?<><h2 style={{fontSize:18}}>Verify your authenticator code</h2><p style={{color:C.dim}}>Enter the current 6-digit code to open your privileged PawSpace session.</p></>:null}
    {(phase==="enroll"||phase==="verify")?<>
      <label style={{fontSize:13,color:C.dim}}>6-digit authenticator code<input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-label="6-digit authenticator code" style={input} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))}/></label>
      <button type="button" disabled={busy} style={{...button,marginTop:14,opacity:busy?.65:1}} onClick={()=>void submit()}>{busy?"Verifying…":phase==="enroll"?"Enable MFA & continue":"Verify & continue"}</button>
    </>:null}
    {message?<p role="status" style={{color:phase==="done"?C.green:"#ffd29a",marginTop:14}}>{message}</p>:null}
    {phase==="error"?<p><Link href="/staging-login" style={{color:C.gold}}>Return to sign-in</Link></p>:null}
    <p style={{fontSize:12,color:C.dim,marginBottom:0,marginTop:22}}>MFA codes are verified server-side. This screen does not bypass privileged-role checks and does not expose protected Finance data before verification.</p>
   </section>
  </div>
 </main>;
}
