"use client";
import {useRef,useState} from "react";
import {Button} from "../../components/ui";
import styles from "../team-console.module.css";
type Failure={id:string;message_id:string;customer_id:string;booking_id?:string;channel:string;reason:string;created_at:number};
export default function DeliveryRecovery(){
 const [rows,setRows]=useState<Failure[]|null>(null),[selected,setSelected]=useState<Failure|null>(null),[reason,setReason]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
 const request=useRef<{key:string;reason:string}|null>(null);
 async function load(){const response=await fetch('/api/communications',{cache:'no-store'}),body=await response.json();if(!response.ok)throw new Error(body.error||'Unable to load failed messages');setRows(body.data.deadLetters);}
 async function refresh(){setBusy(true);setNotice('');try{await load();}catch(error){setNotice(String(error instanceof Error?error.message:error));}finally{setBusy(false);}}
 async function replay(){if(!selected||busy)return;const note=reason.trim();if(!request.current||request.current.reason!==note)request.current={key:crypto.randomUUID(),reason:note};setBusy(true);setNotice('');try{
  const response=await fetch('/api/communications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'replay_dead_letter',messageId:selected.message_id,failureCreatedAt:selected.created_at,requestKey:request.current.key,reason:note})}),body=await response.json();
  if(!response.ok)throw new Error(body.data?.reason||body.error||'Recovery failed');
  setSelected(null);setReason('');request.current=null;setNotice('Message requeued. Delivery will be verified separately.');await load();
 }catch(error){setNotice(String(error instanceof Error?error.message:error));}finally{setBusy(false);}}
 return <section className={styles.panel} aria-label="Delivery recovery">
  <h2>Delivery recovery</h2><p>Review failed messages after correcting their delivery settings. Messages with provider receipts require reconciliation first.</p>
  <Button onClick={refresh} disabled={busy}>{busy?'Working…':'Review failed messages'}</Button>
  {notice?<p role="status">{notice}</p>:null}
  {rows?.length===0?<p>No unresolved delivery failures.</p>:null}
  {rows?.map(row=><div key={row.id} style={{padding:'12px 0',borderBottom:'1px solid #ddd',overflowWrap:'anywhere'}}><strong>{row.customer_id} · {row.channel}</strong><p>{row.booking_id || 'No booking reference'} · {row.message_id}</p><p>{row.reason.replaceAll('_',' ')}</p><Button disabled={busy} onClick={()=>{setSelected(row);setReason('');request.current=null;}}>Review recovery</Button></div>)}
  {selected?<form onSubmit={event=>{event.preventDefault();void replay();}}><p>Recover message {selected.message_id}</p><label htmlFor="delivery-recovery-reason">What was corrected?</label><textarea id="delivery-recovery-reason" value={reason} onChange={event=>setReason(event.target.value)} minLength={10} maxLength={500} required disabled={busy} style={{display:'block',width:'100%',minHeight:80}}/><Button type="submit" disabled={busy||reason.trim().length<10}>Requeue message</Button><Button type="button" disabled={busy} onClick={()=>{setSelected(null);request.current=null;}}>Cancel</Button></form>:null}
 </section>;
}
