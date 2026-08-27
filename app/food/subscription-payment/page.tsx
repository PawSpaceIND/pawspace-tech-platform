"use client";
import Link from"next/link";
import{useEffect,useState}from"react";
import{loadFoodSubscription,type FoodSubscriptionSnapshot}from"../../../lib/food-subscription-client";
import{useQueryParameter}from"../../../lib/use-query-parameter";
import{resourceScreenState}from"../../../lib/resource-screen-state";
export default function FoodSubscriptionPaymentPage(){const renewalId=useQueryParameter("renewalId"),
[data,setData]=useState<FoodSubscriptionSnapshot|null>(null),[loadedId,setLoadedId]=useState(""),[error,setError]=useState("");useEffect(()=>{if(!renewalId)return;void loadFoodSubscription({renewalId}).then(snapshot=>{setData(snapshot);setLoadedId(renewalId)}).catch(problem=>{setError(problem instanceof Error?problem.message:"Unable to load payment request");setLoadedId(renewalId)})},[renewalId]);const renewal=data?.renewals.find(row=>String(row.id)===renewalId);
 /*
  * A renewal that is not there must SAY so. Measured in a browser: with no renewalId, and with one
  * matching nothing, this page rendered its header and then silently nothing - and it is the page a
  * customer reaches from a truncated or expired payment link. [PTJA-P1-F35]
  */
 /*
  * What was loaded, not merely THAT something was loaded. A boolean stays true when the id changes, so
  * the screen would report the previous record's outcome for a new id until the next fetch resolved -
  * the same "flag treated as an answer" shape this whole phase has been unpicking. Recording the id
  * also removes the synchronous setState an effect cannot make without triggering cascading renders.
  */
 const screen=resourceScreenState({id:renewalId,loaded:loadedId===renewalId,resource:renewal,error});
 if(screen!=="ready"){
  const detail=screen==="no-id"?"This payment link is incomplete. Please open the renewal from your Food subscriptions, or check the link you were sent."
   :screen==="failed"?error
   :screen==="loading"?"Loading your renewal…"
   :`No renewal matches ${renewalId}. The link may be out of date, or the renewal may have already been paid.`;
  return <main style={{maxWidth:720,margin:"0 auto",padding:32,fontFamily:"system-ui",display:"grid",gap:12}}><Link href="/food/subscriptions">← Food subscriptions</Link><p>FOOD RENEWAL PAYMENT REQUEST · UAT</p><h1>{renewalId||"Payment request"}</h1><p role={screen==="failed"?"alert":undefined}>{detail}</p></main>;
 }
 return <main style={{maxWidth:720,margin:"0 auto",padding:32,fontFamily:"system-ui"}}><Link href="/food/subscriptions">← Food subscriptions</Link><p>FOOD RENEWAL PAYMENT REQUEST · UAT</p><h1>{renewalId||"Payment request"}</h1>{renewal&&<><h2>₹{Number(renewal.total_amount||0).toLocaleString("en-IN")}</h2><p>Status: {String(renewal.status||"payment_pending").replaceAll("_"," ")}</p><p>This canonical link proves the renewal/payment-link workflow. It does not capture live money. Production Razorpay/payment-link execution must be connected and approved separately; canonical payment confirmation is what triggers the paid message and invoice.</p></>}</main>}
