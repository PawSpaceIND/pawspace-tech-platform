"use client";
import{FormEvent,useEffect,useRef,useState}from"react";
import Link from"next/link";
import styles from"./page.module.css";
type Reply={knowledge?:Array<{title?:string;excerpt?:string}>;duplicatePrevented?:boolean;ai?:{turn?:{output?:string;outcome?:string}};callback?:{matched?:boolean}};
type Turn={question:string;reply:Reply};
type Identity="checking"|"customer"|"guest"|"unavailable";

export default function AiChatPage(){
 const[mode,setMode]=useState<"public"|"authenticated">("public"),[identity,setIdentity]=useState<Identity>("checking"),[message,setMessage]=useState(""),[turns,setTurns]=useState<Turn[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const pending=useRef<{text:string;mode:string;key:string}|null>(null),request=useRef<AbortController|null>(null);
 useEffect(()=>{let active=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 fetch('/api/identity-session',{cache:'no-store',signal:controller.signal}).then(async response=>{if(response.status===401){if(active)setIdentity('guest');return;}if(!response.ok)throw new Error('Session unavailable');const body=await response.json();if(active)setIdentity(body.data?.subjectType==='customer'?'customer':'guest');}).catch(()=>{if(active)setIdentity('unavailable');}).finally(()=>clearTimeout(timer));
 return()=>{active=false;controller.abort();clearTimeout(timer);request.current?.abort();};},[]);
 function choose(next:"public"|"authenticated"){setMode(next);setTurns([]);setError("");pending.current=null;}
 async function submit(event:FormEvent){event.preventDefault();if(busy||!message.trim()||(mode==='authenticated'&&identity!=='customer'))return;
  const question=message.trim();if(!pending.current||pending.current.text!==question||pending.current.mode!==mode)pending.current={text:question,mode,key:crypto.randomUUID()};
  const controller=new AbortController();request.current=controller;const timer=setTimeout(()=>controller.abort(),20000);setBusy(true);setError('');
  try{const body=mode==='public'?{mode,query:question}:{mode,message:question,idempotencyKey:'web-'+pending.current.key};
   const response=await fetch('/api/ai-web-chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
   const payload=await response.json().catch(()=>null) as {data?:Reply;error?:string}|null;
   if(!response.ok){if(response.status===401)setIdentity('guest');throw new Error(payload?.error||'Chat is temporarily unavailable. Please try again.');}
   if(!payload?.data)throw new Error('Chat returned an incomplete response. Please try again.');
   setTurns(current=>[...current,{question,reply:payload.data!}]);setMessage('');pending.current=null;
  }catch(cause){setError(controller.signal.aborted?'The reply is taking too long. Your message is saved here; try sending it again.':cause instanceof Error?cause.message:'Chat is temporarily unavailable. Please try again.');}
  finally{clearTimeout(timer);setBusy(false);request.current=null;}
 }
 return <main className={styles.page}><Link href="/mobile-app">← PawSpace</Link><h1>How can we help?</h1><p>Ask about our services, or sign in for help with your account.</p>
 <div className={styles.modes} aria-label="Chat topic"><button aria-pressed={mode==='public'} disabled={busy} onClick={()=>choose('public')}>Our services</button><button aria-pressed={mode==='authenticated'} disabled={busy} onClick={()=>choose('authenticated')}>My account</button></div>
 {mode==='authenticated'&&identity!=='customer'&&<section className={styles.notice} role="status">{identity==='checking'?<p>Checking your sign-in…</p>:identity==='unavailable'?<><p>We couldn’t check your sign-in. Reload this page to try again, or browse our services.</p><button onClick={()=>window.location.reload()}>Check sign-in again</button></>:<><p>Sign in to your customer account to discuss bookings and account details.</p><Link href="/mobile-app">Open customer app to sign in</Link></>}</section>}
 <section className={styles.history} aria-label="Conversation" aria-live="polite">{turns.map((turn,index)=>{const reply=turn.reply,output=reply.ai?.turn?.output,hasKnowledge=Boolean(reply.knowledge?.length);return <article key={index}><p className={styles.question}>{turn.question}</p><div className={styles.answer}>{output?<p>{output}</p>:hasKnowledge?reply.knowledge!.map((item,i)=><section key={i}><h2>{item.title}</h2><p>{item.excerpt}</p></section>):<p>{reply.callback?.matched?'Your callback request was received. This does not confirm that a call has been placed.':reply.duplicatePrevented?'This message was already received. Please check your account for updates.':mode==='public'?'I couldn’t find an approved answer to that question. Try a specific service, or open the customer app for support.':'Your message was received, but an answer is not available here yet. Open the customer app for support.'}</p>}{(!output&&!hasKnowledge)&&<Link href="/mobile-app">Open customer app</Link>}</div></article>})}</section>
 <form onSubmit={submit}><label htmlFor="chat-message">Your message</label><textarea id="chat-message" value={message} onChange={event=>setMessage(event.target.value)} placeholder="Ask PawSpace" maxLength={4000} disabled={busy}/><button disabled={busy||!message.trim()||(mode==='authenticated'&&identity!=='customer')}>{busy?'Sending…':'Send'}</button></form>
 {busy&&<p role="status">Waiting for a reply…</p>}{error&&<p role="alert" className={styles.error}>{error}</p>}
 </main>;
}
