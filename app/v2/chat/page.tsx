"use client";
import Link from "next/link";
import {FormEvent,useEffect,useRef,useState} from "react";
import styles from "./page.module.css";

type Reply={knowledge?:Array<{title?:string;excerpt?:string}>;sessionKey?:string;duplicatePrevented?:boolean;ai?:{providerConnected?:boolean;turn?:{output?:string;provider?:string;modelRef?:string|null;outcome?:string}};callback?:{matched?:boolean}};
type Turn={question:string;reply:Reply};
type Identity="checking"|"customer"|"guest"|"unavailable";

const SUGGESTIONS=["Book grooming for my dog","Tell me about dog training","What is included in boarding?","How does pet taxi work?"];
function cleanAiText(value:string){return value.replace(/\*\*/g,"").trim();}

export default function V2Chat(){
 const[mode,setMode]=useState<"public"|"authenticated">("public"),[identity,setIdentity]=useState<Identity>("checking"),[message,setMessage]=useState(""),[turns,setTurns]=useState<Turn[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false),[publicSessionKey]=useState(()=>crypto.randomUUID());
 const pending=useRef<{text:string;mode:string;key:string}|null>(null),request=useRef<AbortController|null>(null),endRef=useRef<HTMLDivElement|null>(null);
 useEffect(()=>{let active=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);fetch("/api/identity-session",{cache:"no-store",signal:controller.signal}).then(async r=>{if(r.status===401){if(active)setIdentity("guest");return;}if(!r.ok)throw new Error("Session unavailable");const b=await r.json();if(active)setIdentity(b.data?.subjectType==="customer"?"customer":"guest");}).catch(()=>{if(active)setIdentity("unavailable");}).finally(()=>clearTimeout(timer));return()=>{active=false;controller.abort();clearTimeout(timer);request.current?.abort();};},[]);
 useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth",block:"end"});},[turns,busy]);
 function choose(next:"public"|"authenticated"){setMode(next);setTurns([]);setError("");pending.current=null;}
 async function submit(e:FormEvent){e.preventDefault();if(busy||!message.trim()||(mode==="authenticated"&&identity!=="customer"))return;const question=message.trim();if(!pending.current||pending.current.text!==question||pending.current.mode!==mode)pending.current={text:question,mode,key:crypto.randomUUID()};const controller=new AbortController();request.current=controller;const timer=setTimeout(()=>controller.abort(),20000);setBusy(true);setError("");
  try{const history=turns.flatMap(turn=>[{role:"user" as const,text:turn.question},{role:"assistant" as const,text:turn.reply.ai?.turn?.output||""}]).filter(item=>item.text).slice(-8);const body=mode==="public"?{mode,message:question,sessionKey:publicSessionKey,history}:{mode,message:question,idempotencyKey:"v2-web-"+pending.current.key};const r=await fetch("/api/ai-web-chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:controller.signal});const payload=await r.json().catch(()=>null) as {data?:Reply;error?:string}|null;if(!r.ok){if(r.status===401)setIdentity("guest");throw new Error(payload?.error||"Chat is temporarily unavailable.");}if(!payload?.data)throw new Error("Chat returned an incomplete response.");setTurns(x=>[...x,{question,reply:payload.data!}]);setMessage("");pending.current=null;}catch(cause){setError(controller.signal.aborted?"The reply is taking too long. Try sending again.":cause instanceof Error?cause.message:"Chat is temporarily unavailable.");}finally{clearTimeout(timer);setBusy(false);request.current=null;}}
 const authenticatedReady=mode==="authenticated"&&identity==="customer";
 const statusLabel=mode==="public"?"AI online - PawSpace knowledge":authenticatedReady?"AI online - Account-aware":"Sign in for account-aware help";
 return <main className={styles.page} data-identity={identity}>
  <div className={styles.chatShell}>
   <header className={styles.chatHeader}>
    <Link href="/v2" className={styles.brand}><img src="/assets/pawspace-icon.jpeg" alt=""/><span className={styles.brandCopy}><strong>PawSpace AI</strong><small>{statusLabel}</small></span></Link>
    <Link href="/v2" className={styles.back}>Home</Link>
   </header>
   <div className={styles.modeBar} aria-label="Chat topic"><button aria-pressed={mode==="public"} disabled={busy} onClick={()=>choose("public")}>Ask PawSpace AI</button><button aria-pressed={mode==="authenticated"} disabled={busy} onClick={()=>choose("authenticated")}>My PawSpace</button></div>
   <section className={styles.conversation} aria-label="Conversation" aria-live="polite">
    {turns.length===0&&<div className={styles.welcome}><img src="/assets/pawspace-icon.jpeg" alt=""/><h1>Ask PawSpace anything.</h1><p>{mode==="public"?"I can help with PawSpace services, packages, booking information and pet-care questions using approved PawSpace knowledge.":"I can help with your PawSpace account, bookings and care history once you are signed in."}</p>{mode==="public"&&<div className={styles.suggestions}>{SUGGESTIONS.map(item=><button key={item} type="button" onClick={()=>setMessage(item)}>{item}</button>)}</div>}</div>}
    {mode==="authenticated"&&identity!=="customer"&&<section className={styles.notice} role="status">{identity==="checking"?<p>Checking your PawSpace sign-in...</p>:identity==="unavailable"?<><p>We could not check your sign-in.</p><button onClick={()=>window.location.reload()}>Check again</button></>:<><p>Sign in from the V2 home to discuss bookings and account details.</p><Link href="/v2">Open V2 home</Link></>}</section>}
    {turns.map((turn,index)=>{const output=turn.reply.ai?.turn?.output;const answer=output?cleanAiText(output):(turn.reply.callback?.matched?"Your callback request was received.":turn.reply.duplicatePrevented?"This message was already received.":"I could not produce a verified answer right now.");return <div className={styles.exchange} key={index}><article className={styles.userRow}><div className={styles.userBubble}><p>{turn.question}</p></div></article><article className={styles.aiRow}><img className={styles.avatar} src="/assets/pawspace-icon.jpeg" alt=""/><div className={styles.aiBubble}><div className={styles.aiLabel}>PawSpace AI</div><p>{answer}</p></div></article></div>})}
    {busy&&<div className={styles.aiRow} role="status"><img className={styles.avatar} src="/assets/pawspace-icon.jpeg" alt=""/><div className={`${styles.aiBubble} ${styles.typing}`}><span></span><span></span><span></span></div></div>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}<div ref={endRef}/>
   </section>
   <form className={styles.composer} onSubmit={submit}><div className={styles.inputWrap}><textarea id="v2-chat-message" aria-label="Your message" value={message} onChange={e=>setMessage(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit();}}} placeholder={mode==="public"?"Message PawSpace AI":"Ask about your PawSpace account"} maxLength={4000} rows={1} disabled={busy}/><button data-v2-action="primary" className={styles.send} aria-label="Send message" disabled={busy||!message.trim()||(mode==="authenticated"&&identity!=="customer")}>{busy?"...":"Send"}</button></div><p className={styles.helper}>Enter to send - Shift+Enter for a new line</p></form>
  </div>
  <nav className={styles.dock} aria-label="PawSpace V2 navigation"><Link href="/v2"><strong>Home</strong></Link><Link href="/v2/grooming"><strong>Book</strong></Link><Link href="/v2/chat" className={styles.active}><strong>AI</strong></Link><Link href="/v2/activity"><strong>Activity</strong></Link></nav>
 </main>;
}
