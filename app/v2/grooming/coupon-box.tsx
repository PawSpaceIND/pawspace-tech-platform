"use client";
import { useEffect, useRef, useState } from "react";
import { quoteGovernedCoupon } from "../../../lib/coupon-governance-client";
import { groomingCouponPayable } from "../../../lib/v2/grooming-money";
import { loadV2GroomingOffers, type V2GroomingOffers } from "../../../lib/v2/grooming-offers-client";
import styles from "./grooming.module.css";
import offersStyle from "./offers.module.css";

type Props = {customerId:string;cityId:string;packageCode:string;orderValue:number;onChange:(discount:number,code:string,quoteId?:string)=>void};
const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:0,maximumFractionDigits:2}).format(value);

/** Only the server can approve a discount. Offer browsing is read-only and private codes stay unlisted. */
export default function V2GroomingCouponBox({customerId,cityId,packageCode,orderValue,onChange}:Props){
  const [code,setCode]=useState(""),[applied,setApplied]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  const offerKey=JSON.stringify([customerId,cityId,packageCode,orderValue]);
  const [offersResult,setOffersResult]=useState<{key:string;data:V2GroomingOffers}|null>(null);
  const [offersFailure,setOffersFailure]=useState<{key:string;text:string}|null>(null),[retry,setRetry]=useState(0);
  const offers=offersResult?.key===offerKey?offersResult.data:null;
  const offersError=offersFailure?.key===offerKey?offersFailure.text:"";
  const version=useRef(0);
  useEffect(()=>()=>{version.current++;},[]);
  useEffect(()=>{
    const controller=new AbortController();let current=true;
    loadV2GroomingOffers({customerId,cityId,packageCode,orderValue},controller.signal)
      .then(value=>{if(current)setOffersResult({key:offerKey,data:value});})
      .catch(error=>{if(current)setOffersFailure({key:offerKey,text:error instanceof Error?error.message:"Available offers could not be checked."});});
    return()=>{current=false;controller.abort();};
  },[customerId,cityId,packageCode,orderValue,offerKey,retry]);
  const remove=()=>{version.current++;setBusy(false);setCode("");setApplied("");setMessage("");onChange(0,"");};
  const apply=async(value=code)=>{
    const normalized=value.trim().toUpperCase();if(!normalized||busy)return;
    const current=++version.current;setCode(normalized);setBusy(true);setApplied("");setMessage("");onChange(0,normalized);
    try{
      const result=await quoteGovernedCoupon({ code: normalized, customerId, serviceCode: "grooming", cityId, channel: "website", packageCode, orderValue, paymentMode:"full",isSubscription:false });
      if(current!==version.current)return;
      if(!result.valid||!result.code||!result.quoteId){onChange(0,normalized);setMessage(result.error||"This coupon is not eligible for this booking.");return;}
      groomingCouponPayable(orderValue,result);
      setApplied(result.code);setMessage(`${result.code} applied. You save ${money(result.discount)}.`);onChange(result.discount,result.code,result.quoteId);
    }catch(error){if(current!==version.current)return;onChange(0,normalized);setMessage(error instanceof Error?error.message:"We could not check this coupon.");}
    finally{if(current===version.current)setBusy(false);}
  };
  return <div className={`${styles.addressBox} ${offersStyle.offers}`} role="group" aria-label="Coupon code">
    <section aria-label="Available offers">
      <h3>Available offers</h3>
      {!offers&&!offersError&&<p role="status">Checking offers for this booking…</p>}
      {offersError&&<><p role="status">{offersError} You can continue without a coupon.</p><button type="button" onClick={()=>{setOffersResult(null);setOffersFailure(null);setRetry(value=>value+1);}}>Retry offers</button></>}
      {offers&&!offers.normalCouponsAllowed&&<p>{offers.message||"Normal offers are available for your first three bookings. Use a special code issued to your account."}</p>}
      {offers?.normalCouponsAllowed&&offers.coupons.length===0&&<p>No normal offer matches this booking. Special codes are checked separately.</p>}
      {offers?.coupons.map((offer,index)=><article key={offer.code} className={offersStyle.card}>
        <div><b>{offer.name}</b>{index===0&&<small>Best available saving</small>}<span>{offer.savings!==undefined?`Save ${money(offer.savings)}`:offer.description}</span><small>{offer.description}</small>{offer.validUntil&&<small>Valid until {new Date(offer.validUntil).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata"})}</small>}</div>
        <button type="button" aria-label={`Apply ${offer.code}`} disabled={busy||applied===offer.code} onClick={()=>void apply(offer.code)}>{applied===offer.code?"Applied":"Apply"}</button>
      </article>)}
    </section>
    <details><summary>Have a special code?</summary>
      <label>Special code<input value={code} disabled={busy} autoComplete="off" placeholder="Enter your privately shared code" onChange={event=>{version.current++;setCode(event.target.value);setApplied("");setMessage("");onChange(0,"");}} /></label>
      <button type="button" disabled={busy||!code.trim()} onClick={()=>void apply()}>{busy?"Checking…":applied?"Applied":"Apply"}</button>
    </details>
    {message&&<p role={applied?"status":"alert"} className={applied?styles.helper:styles.inlineError}>{message}</p>}
    {(applied||code)&&<button type="button" onClick={remove}>Remove coupon</button>}
    <small>One offer per booking. Changing your basket rechecks eligibility.</small>
  </div>;
}
