"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { quoteGovernedCoupon } from "../../../lib/coupon-governance-client";
import { groomingCouponPayable } from "../../../lib/v2/grooming-money";
import { loadV2GroomingOffers, type V2GroomingOffers } from "../../../lib/v2/grooming-offers-client";
import styles from "./grooming.module.css";
import offersStyle from "./offers.module.css";

export type V2CouponIntent = {customerId:string;mode:"automatic"|"manual"|"editing"|"removed";code:string};
type Props = {isSubscription?:boolean;customerId:string;cityId:string;packageCode:string;orderValue:number;contextKey:string;paymentMode:"prepaid"|"pay_after_service";
  intentRef:{current:V2CouponIntent};onChecked:(contextKey:string)=>void;
  onChange:(discount:number,code:string,quoteId?:string)=>void};
const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:0,maximumFractionDigits:2}).format(value);

/** Only the server can approve a discount. Offer browsing is read-only and private codes stay unlisted. */
export default function V2GroomingCouponBox({customerId,cityId,packageCode,orderValue,contextKey,paymentMode,isSubscription=false,intentRef,onChecked,onChange}:Props){
  const [code,setCode]=useState(""),[applied,setApplied]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  // An automatically applied offer that no longer matches (or could not be re-checked): reported to the page so booking stays
  // blocked until the customer chooses again or removes it, but never written into the special-code field.
  const [stale,setStale]=useState("");
  const offerKey=JSON.stringify([customerId,cityId,packageCode,orderValue,isSubscription]);
  const [offersResult,setOffersResult]=useState<{key:string;data:V2GroomingOffers}|null>(null);
  const [offersFailure,setOffersFailure]=useState<{key:string;text:string}|null>(null),[retry,setRetry]=useState(0);
  const offers=offersResult?.key===offerKey?offersResult.data:null;
  const offersError=offersFailure?.key===offerKey?offersFailure.text:"";
  const version=useRef(0);
  const invalidateRequest=useCallback(()=>{version.current++;},[]);
  const apply=useCallback(async(value:string,mode:"automatic"|"manual"="manual")=>{
    const normalized=value.trim().toUpperCase();if(!normalized)return;
    const current=++version.current;
    intentRef.current={customerId,mode,code:normalized};
    // Workbook Grooming row 5: an automatically applied offer is reported as applied, never typed into the special-code box.
    if(mode==="manual")setCode(normalized);setStale("");setBusy(true);setApplied("");setMessage("");onChange(0,normalized);
    try{
      const result=await quoteGovernedCoupon({ code: normalized, customerId, serviceCode: "grooming", cityId, channel: "website", packageCode, orderValue, paymentMode:paymentMode==="prepaid"?"full":"after_service",isSubscription });
      if(current!==version.current)return;
      if(!result.valid||result.code!==normalized||!result.quoteId){if(mode==="automatic")setStale(normalized);onChange(0,normalized);setMessage(result.error||"This coupon is not eligible for this booking. Remove it or choose another offer.");return;}
      groomingCouponPayable(orderValue,result);
      setApplied(result.code);setMessage(`${result.code} ${mode==="automatic"?"automatically applied":"applied"}. You save ${money(result.discount)}.`);onChange(result.discount,result.code,result.quoteId);
    }catch(error){if(current!==version.current)return;if(mode==="automatic")setStale(normalized);onChange(0,normalized);setMessage(error instanceof Error?error.message:"We could not check this coupon.");}
    finally{if(current===version.current){setBusy(false);onChecked(contextKey);}}
  },[customerId,cityId,packageCode,orderValue,contextKey,paymentMode,isSubscription,intentRef,onChange,onChecked]);
  useEffect(()=>{
    const controller=new AbortController();let current=true;const initialVersion=version.current;
    loadV2GroomingOffers({customerId,cityId,packageCode,orderValue,isSubscription},controller.signal)
      .then(value=>{
        if(!current)return;
        setOffersResult({key:offerKey,data:value});setOffersFailure(null);
        // A manual choice, typing or Remove during the read always wins over late auto-application.
        if(version.current!==initialVersion)return;
        const intent=intentRef.current.customerId===customerId?intentRef.current:{customerId,mode:"automatic" as const,code:""};
        intentRef.current=intent;
        if(intent.mode==="removed"){onChange(0,"");onChecked(contextKey);return;}
        if(intent.mode==="editing"){setCode(intent.code);onChange(0,intent.code);onChecked(contextKey);return;}
        if(intent.mode==="manual"){if(intent.code)void apply(intent.code,"manual");else{onChange(0,"");onChecked(contextKey);}return;}
        const best=value.normalCouponsAllowed?value.coupons[0]:undefined;
        if(best){void apply(best.code,"automatic");return;}
        if(intent.code){if(intent.mode==="automatic")setStale(intent.code);else setCode(intent.code);setMessage(`Your previous coupon ${intent.code} no longer matches this booking. Choose an offer again or remove it.`);onChange(0,intent.code);}
        else onChange(0,"");
        onChecked(contextKey);
      })
      .catch(error=>{
        if(!current)return;
        setOffersFailure({key:offerKey,text:error instanceof Error?error.message:"Available offers could not be checked."});
        if(version.current!==initialVersion)return;
        const intent=intentRef.current;
        if(intent.customerId===customerId&&intent.mode!=="removed"&&intent.code){if(intent.mode==="automatic")setStale(intent.code);else setCode(intent.code);onChange(0,intent.code);}
        onChecked(contextKey);
      });
    return()=>{current=false;controller.abort();invalidateRequest();};
  },[customerId,cityId,packageCode,orderValue,isSubscription,offerKey,retry,contextKey,intentRef,apply,onChange,onChecked,invalidateRequest]);
  const remove=()=>{version.current++;intentRef.current={customerId,mode:"removed",code:""};setBusy(false);setCode("");setStale("");setApplied("");setMessage("Coupon removed. Choose an offer to apply a discount again.");onChange(0,"");onChecked(contextKey);};
  const editCode=(value:string)=>{version.current++;intentRef.current={customerId,mode:"editing",code:value.trim().toUpperCase()};setBusy(false);setCode(value);setStale("");setApplied("");setMessage("");onChange(0,value.trim().toUpperCase());onChecked(contextKey);};
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
      <label>Special code<input value={code} disabled={busy} autoComplete="off" placeholder="Enter your privately shared code" onChange={event=>editCode(event.target.value)} /></label>
      <button type="button" disabled={busy||!code.trim()} onClick={()=>void apply(code)}>{busy?"Checking…":applied?"Applied":"Apply"}</button>
    </details>
    {message&&<p role={applied||!code?"status":"alert"} className={applied?styles.helper:styles.inlineError}>{message}</p>}
    {applied&&!code&&<p className={offersStyle.appliedChip} role="status"><b>{applied}</b> applied to this booking</p>}
    {stale&&!applied&&!code&&<p role="alert" className={styles.inlineError}>Offer {stale} is no longer applied. Choose an offer again or remove it to continue.</p>}
    {(applied||code||stale||busy)&&<button type="button" onClick={remove}>Remove coupon</button>}
    <small>The best eligible normal offer applies automatically. Change or remove it at any time. One offer per booking.</small>
  </div>;
}
