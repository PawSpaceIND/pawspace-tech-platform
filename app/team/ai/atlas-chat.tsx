"use client";
import {useCallback,useEffect,useRef,useState} from "react";
type Message={id:string;role:"founder"|"atlas";content:string;createdAt:number;actionStatus?:string|null};
type Answer={messageId:string;content:string;narrativeAvailable:boolean;narrativeReason:string|null};
export function AtlasChat(){
 const[messages,setMessages]=useState<Message[]>([]),[question,setQuestion]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[answer,setAnswer]=useState<Answer|null>(null);
 const pending=useRef(false);
 const load=useCallback(async(signal?:AbortSignal)=>{const response=await fetch("/api/admin/atlas-chat?limit=30",{cache:"no-store",signal});const body=await response.json();if(!response.ok)throw new Error(body.error||"Founder access is required to read Atlas conversations.");return body.data?.messages||[];},[]);
 useEffect(()=>{const controller=new AbortController();void load(controller.signal).then(messages=>{if(!controller.signal.aborted)setMessages(messages);}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:"Unable to load Atlas conversations.");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[load]);
 async function ask(event:React.FormEvent){event.preventDefault();const message=question.trim();if(!message||pending.current)return;pending.current=true;setBusy(true);setError("");setAnswer(null);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),150000);
  try{const response=await fetch("/api/admin/atlas-chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"ask",message}),signal:controller.signal});const body=await response.json();if(!response.ok)throw new Error(body.error||"Atlas could not answer this question.");setAnswer(body.data);setQuestion("");try{setMessages(await load(controller.signal));}catch{setError("Your answer was received, but history could not refresh. Reload history before sending again.");}}
  catch(e){setError(controller.signal.aborted?"Atlas took too long. Reload history to check whether your answer was saved before retrying.":e instanceof Error?e.message:"Atlas is unavailable.");}
  finally{clearTimeout(timer);pending.current=false;setBusy(false);}
 }
 return <section aria-label="Ask Atlas" style={{background:"var(--staff-surface)",border:"1px solid var(--staff-line)",borderRadius:14,padding:16,marginBottom:16}}>
  <h2>Ask Atlas</h2><p>Founder questions use current PawSpace records. Asking a question does not approve or execute an action. Include the full context in each question.</p>
  {error&&<p role="alert">{error}</p>}
  <button type="button" disabled={busy||loading} onClick={()=>{setLoading(true);setError("");void load().catch(e=>setError(e.message)).finally(()=>setLoading(false));}}>Reload Atlas history</button>
  {loading?<p role="status">Loading Atlas history…</p>:<div aria-label="Atlas conversation" style={{maxHeight:480,overflowY:"auto"}}>{messages.length===0?<p>No saved Atlas conversation.</p>:messages.map(item=><article key={item.id} style={{padding:"12px 0",borderBottom:"1px solid var(--staff-line)",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}><strong>{item.role==="founder"?"Founder":"Atlas"}</strong><p>{item.content}</p>{item.actionStatus&&<small>Action status: {item.actionStatus}. Review through the existing approval workflow.</small>}</article>)}</div>}
  {answer&&<div role="status"><strong>{answer.narrativeAvailable?"Model response received":"Verified-facts fallback — model narrative unavailable"}</strong>{answer.narrativeReason&&<p>Reason: {answer.narrativeReason}</p>}<p style={{whiteSpace:"pre-wrap"}}>{answer.content}</p></div>}
  <form onSubmit={ask}><label htmlFor="atlas-question">Question for Atlas</label><textarea id="atlas-question" value={question} onChange={event=>setQuestion(event.target.value)} maxLength={6000} rows={4} disabled={busy} style={{display:"block",width:"100%",boxSizing:"border-box",margin:"8px 0"}}/><button disabled={busy||loading||!question.trim()}>{busy?"Atlas is answering…":"Ask Atlas"}</button></form>
 </section>;
}
