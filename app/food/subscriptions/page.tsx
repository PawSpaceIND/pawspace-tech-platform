"use client";
import Link from"next/link";
import{useEffect,useState}from"react";
import{createFoodSubscription,loadFoodSubscription,updateFoodSubscription,type FoodSubscriptionSnapshot}from"../../../lib/food-subscription-client";

const box={background:"white",border:"1px solid #e1e1e1",borderRadius:14,padding:18} as const;
const label=(value:unknown)=>String(value||"not set").replaceAll("_"," ");

export default function FoodSubscriptionsPage(){
 const[subscriptionId,setSubscriptionId]=useState(()=>typeof window==="undefined"?"":new URLSearchParams(window.location.search).get("subscriptionId")||"");
 const[sourceOrderId,setSourceOrderId]=useState(()=>typeof window==="undefined"?"":new URLSearchParams(window.location.search).get("sourceOrderId")||"");
 const[days,setDays]=useState(30);
 const[data,setData]=useState<FoodSubscriptionSnapshot|null>(null);
 const[busy,setBusy]=useState("");
 const[error,setError]=useState("");

 useEffect(()=>{
  if(!subscriptionId)return;
  let active=true;
  void loadFoodSubscription({subscriptionId}).then(snapshot=>{
   if(!active)return;
   setData(snapshot);
   setError("");
  }).catch(problem=>{
   if(!active)return;
   setError(problem instanceof Error?problem.message:"Unable to load Food subscription");
  });
  return()=>{active=false};
 },[subscriptionId]);

 async function create(){
  if(!sourceOrderId||busy)return;
  setBusy("create");setError("");
  try{
   const result=await createFoodSubscription({sourceOrderId,renewalIntervalDays:days,communicationChannel:"whatsapp"}),id=String(result.subscriptionId||"");
   setSubscriptionId(id);
   if(id)setData(await loadFoodSubscription({subscriptionId:id}));
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to create Food subscription")}
  finally{setBusy("")}
 }

 async function status(action:"pause"|"resume"|"cancel"){
  if(!subscriptionId||busy)return;
  setBusy(action);setError("");
  try{
   await updateFoodSubscription({subscriptionId,action,reason:`Customer ${action} request from Food subscription workspace`});
   setData(await loadFoodSubscription({subscriptionId}));
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to update Food subscription")}
  finally{setBusy("")}
 }

 const subscription=data?.subscription||{},renewals=data?.renewals||[],invoices=data?.invoices||[];
 return <main style={{maxWidth:1180,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16}}>
  <header><Link href="/food">← Food</Link><p>FOOD SUBSCRIPTION · CANONICAL UAT</p><h1>Renew by payment link, never silent auto-charge</h1><p>When a configured renewal becomes due, PawSpace creates one idempotent payment-link cycle and queues the transactional message. After canonical payment confirmation, the paid message and UAT invoice are queued automatically.</p></header>
  {error&&<p role="alert">{error}</p>}
  {!data&&<section style={box}><h2>Start from an existing canonical Food order</h2><label>Source order ID<input value={sourceOrderId} onChange={event=>setSourceOrderId(event.target.value)} style={{display:"block",width:"100%",padding:10,marginTop:6}}/></label><label>Customer-selected renewal interval (days)<input type="number" min={7} max={90} value={days} onChange={event=>setDays(Number(event.target.value))} style={{display:"block",width:"100%",padding:10,marginTop:6}}/></label><p><small>The interval is explicit per subscription; PawSpace does not invent a production cadence or silently change price.</small></p><button disabled={!!busy||!sourceOrderId} onClick={()=>void create()}>{busy?"Creating…":"Create subscription"}</button></section>}
  {data&&<><section style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}><article style={box}><small>Subscription</small><strong style={{display:"block"}}>{String(subscription.id)}</strong><span>{label(subscription.status)}</span></article><article style={box}><small>Next renewal</small><strong style={{display:"block"}}>{new Date(Number(subscription.next_renewal_at||0)).toLocaleString("en-IN")}</strong><span>Every {String(subscription.renewal_interval_days)} days</span></article><article style={box}><small>Payment method</small><strong style={{display:"block"}}>Payment link</strong><span>No silent auto-charge · live money disabled</span></article></section>
  <section style={box}><h2>Renewal cycles</h2>{renewals.length===0?<p>No renewal cycle has become due yet.</p>:renewals.map(row=><article key={String(row.id)} style={{padding:"12px 0",borderBottom:"1px solid #eee"}}><strong>{String(row.id)} · {label(row.status)}</strong><div>₹{Number(row.total_amount||0).toLocaleString("en-IN")} · cycle {String(row.cycle_no)}</div>{!!row.payment_link_path&&<Link href={String(row.payment_link_path)}>Open UAT payment request</Link>}{!!row.invoice_id&&<div><Link href={`/food/subscription-invoice?invoiceId=${encodeURIComponent(String(row.invoice_id))}`}>Open invoice</Link></div>}</article>)}</section>
  <section style={box}><h2>Invoices</h2>{invoices.length===0?<p>No paid-renewal invoice yet.</p>:invoices.map(row=><p key={String(row.id)}><Link href={`/food/subscription-invoice?invoiceId=${encodeURIComponent(String(row.id))}`}>{String(row.invoice_number)}</Link> · ₹{Number(row.net_amount||0).toLocaleString("en-IN")} · {label(row.tax_rule_status)}</p>)}</section>
  <section style={box}><h2>Controls</h2><div style={{display:"flex",gap:8,flexWrap:"wrap"}}><button disabled={!!busy||String(subscription.status)!=="active"} onClick={()=>void status("pause")}>Pause</button><button disabled={!!busy||String(subscription.status)!=="paused"} onClick={()=>void status("resume")}>Resume</button><button disabled={!!busy||String(subscription.status)==="cancelled"} onClick={()=>void status("cancel")}>Cancel</button></div><p><small>Production scheduler, live payment-link provider, GST/tax rules and external messaging delivery remain launch/configuration dependencies.</small></p></section></>}
 </main>
}
