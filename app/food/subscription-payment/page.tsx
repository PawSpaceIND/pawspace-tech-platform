"use client";
import Link from"next/link";
import{useEffect,useState}from"react";
import{loadFoodSubscription,payFoodRenewal,type FoodSubscriptionSnapshot}from"../../../lib/food-subscription-client";
import{useQueryParameter}from"../../../lib/use-query-parameter";
import{resourceScreenState}from"../../../lib/resource-screen-state";
export default function FoodSubscriptionPaymentPage(){const renewalId=useQueryParameter("renewalId"),
[data,setData]=useState<FoodSubscriptionSnapshot|null>(null),[loadedId,setLoadedId]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState("");useEffect(()=>{if(!renewalId)return;void loadFoodSubscription({renewalId}).then(snapshot=>{setData(snapshot);setLoadedId(renewalId)}).catch(problem=>{setError(problem instanceof Error?problem.message:"Unable to load payment request");setLoadedId(renewalId)})},[renewalId]);const renewal=data?.renewals.find(row=>String(row.id)===renewalId);
 const screen=resourceScreenState({id:renewalId,loaded:loadedId===renewalId,resource:renewal,error});
 async function pay(method:"cash"|"online_sandbox"){
  if(!renewalId)return;
  setBusy(method);setError("");
  try{
    await payFoodRenewal({renewalId,method});
    const snapshot=await loadFoodSubscription({renewalId});
    setData(snapshot);
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to record payment")}
  finally{setBusy("")}
 }
 if(screen!=="ready"){
  const detail=screen==="no-id"?"This payment link is incomplete. Please open the renewal from your Food subscriptions, or check the link you were sent."
   :screen==="failed"?error
   :screen==="loading"?"Loading your renewal…"
   :`No renewal matches ${renewalId}. The link may be out of date, or the renewal may have already been paid.`;
  return <main style={{maxWidth:720,margin:"0 auto",padding:32,fontFamily:"system-ui",display:"grid",gap:12}}><Link href="/food/subscriptions">← Food subscriptions</Link><p>FOOD RENEWAL PAYMENT REQUEST · UAT</p><h1>{renewalId||"Payment request"}</h1><p role={screen==="failed"?"alert":undefined}>{detail}</p></main>;
 }
 const paid=String(renewal?.status||"")==="paid_invoiced"||String(renewal?.status||"").includes("paid");
 return <main style={{maxWidth:720,margin:"0 auto",padding:32,fontFamily:"system-ui",display:"grid",gap:14}}><Link href="/food/subscriptions">← Food subscriptions</Link><p>FOOD RENEWAL PAYMENT REQUEST · UAT</p><h1>{renewalId}</h1>{renewal&&<><h2>₹{Number(renewal.total_amount||0).toLocaleString("en-IN")}</h2><p>Status: {String(renewal.status||"payment_pending").replaceAll("_"," ")}</p>{error&&<p role="alert">{error}</p>}{paid?<p>Payment recorded. Invoice will follow the paid confirmation path.</p>:<div style={{display:"flex",gap:12,flexWrap:"wrap"}}><button disabled={Boolean(busy)} onClick={()=>void pay("online_sandbox")}>{busy==="online_sandbox"?"Recording…":"Pay online (sandbox)"}</button><button disabled={Boolean(busy)} onClick={()=>void pay("cash")}>{busy==="cash"?"Recording…":"Pay cash"}</button></div>}<p>This canonical link proves the renewal/payment-link workflow. It does not capture live money. Production Razorpay/payment-link execution must be connected and approved separately; canonical payment confirmation is what triggers the paid message and invoice. Cash and sandbox buttons record that confirmation and the collection ledger only.</p></>}</main>}
