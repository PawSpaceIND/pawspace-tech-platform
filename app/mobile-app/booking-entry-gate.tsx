"use client";
import {useEffect,useMemo,useState} from "react";
import CustomerLogin,{type LoggedInCustomer} from "./customer-login";
import AddressPicker,{type ZoneResult} from "./address-picker";
import {loadV2CustomerAccount,updateV2CustomerProfile,upsertV2CustomerAddress} from "../../lib/v2/customer-experience-client";

type ServiceSummary={name:string;subtitle:string;serviceCode:string;icon:string};
const OPTIONS:Record<string,string[]>={
 grooming:["Doorstep grooming packages and add-ons","Choose date, slot and preferred eligible groomer","Prepaid or pay-after-service where eligible"],
 dog_training:["Compare training programmes, sessions and outcomes","Meet & Greet and programme options","Choose trainer availability, schedule and payment plan"],
 boarding:["Compare stay windows and verified host options","Review care needs, dates and pricing","Prepaid or eligible split-payment schedule"],
 pet_sitting:["Home visit and overnight sitting options","Compare sitter availability and care windows","Review price and payment schedule before request"],
 dog_walking:["Single and recurring walking options","Compare walk duration, schedule and per-walk pricing","Pay after completed walks under the current plan"],
 pet_taxi:["One-way and round-trip ride options","Vehicle, pickup/drop, waiting and pet requirements","Review fare and booking fee before reservation"],
 food:["Browse fresh-food items and quantities","Choose delivery window and address","Review total before prepaid order"],
 relocation:["Browse relocation support and enquiry details","Share route, pet and travel requirements","No payment at enquiry stage"]
};
export function GuestBookingPreview({service,onLoggedIn}:{service:ServiceSummary;onLoggedIn:(customer:LoggedInCustomer)=>void}){
 const[ready,setReady]=useState(false);const bullets=OPTIONS[service.serviceCode]||[service.subtitle];
 return <section style={{display:"grid",gap:14}} aria-label={`${service.name} guest booking preview`}>
  <div style={{border:"1px solid #e8e3ef",borderRadius:"var(--paw-card-radius)",padding:18,background:"#fff"}}><small>EXPLORE AS GUEST</small><h3 style={{margin:"6px 0"}}>{service.icon} {service.name}</h3><p>{service.subtitle}. Browse the service before signing in.</p><ul>{bullets.map(item=><li key={item} style={{margin:"8px 0"}}>{item}</li>)}</ul><p style={{fontSize:13,color:"#6f687b"}}>No OTP is required to browse. We only verify your mobile when you choose to continue to booking.</p><button type="button" onClick={()=>setReady(true)} style={{width:"100%",padding:13,borderRadius:"var(--paw-card-radius)",border:0,fontWeight:700}}>Continue to booking</button></div>
  {ready&&<div style={{border:"1px solid #e8e3ef",borderRadius:"var(--paw-card-radius)",padding:18,background:"#fff"}}><h3 style={{marginTop:0}}>Verify your mobile</h3><p>Your {service.name} choices stay in this booking journey while you verify.</p><CustomerLogin embedded onLoggedIn={onLoggedIn}/><button type="button" onClick={()=>setReady(false)} style={{marginTop:8}}>← Keep browsing</button></div>}
 </section>;
}
export function BookingEntryDetails({service,customer,onContinue,onCustomerUpdated}:{service:ServiceSummary;customer:LoggedInCustomer;onContinue:()=>void;onCustomerUpdated:(customer:LoggedInCustomer)=>void}){
 const[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
 const[name,setName]=useState(customer.customerName),[secondary,setSecondary]=useState(""),[location,setLocation]=useState<ZoneResult|null>(null);
 const[initialAddress,setInitialAddress]=useState<{line1:string;line2?:string|null;postalCode?:string|null}|undefined>();
 const cityId=useMemo(()=>location?.assignment.cityId||"blr",[location]);
 useEffect(()=>{let active=true;loadV2CustomerAccount().then(account=>{if(!active)return;setName(account.name||customer.customerName);setSecondary(account.secondaryPhone||"");const saved=account.addresses.find(a=>a.isDefault)||account.addresses[0];if(saved)setInitialAddress({line1:saved.line1,line2:saved.line2,postalCode:saved.postalCode});}).catch(()=>{}).finally(()=>{if(active)setLoading(false)});return()=>{active=false};},[customer.customerId,customer.customerName]);
 async function proceed(){if(saving)return;if(name.trim().length<2){setError("Enter your name before continuing.");return;}if(secondary&&secondary.length!==10){setError("Alternate mobile must be 10 digits or left blank.");return;}if(!location?.zone.serviceAvailable){setError("Confirm a service address before continuing.");return;}setSaving(true);setError("");try{await updateV2CustomerProfile({name:name.trim(),primaryPhone:customer.phone,secondaryPhone:secondary||null,cityId,idempotencyKey:`booking-entry-profile:${customer.customerId}:${service.serviceCode}:${Date.now()}`});await upsertV2CustomerAddress({label:"Service address",line1:location.addressLine1,line2:location.addressLine2||null,area:location.assignment.area,city:location.assignment.city,postalCode:location.assignment.pincode,isDefault:true,idempotencyKey:`booking-entry-address:${customer.customerId}:${service.serviceCode}:${Date.now()}`});onCustomerUpdated({...customer,customerName:name.trim()});onContinue();}catch(problem){setError(problem instanceof Error?problem.message:"Unable to save your booking details.");}finally{setSaving(false)}}
 return <section style={{display:"grid",gap:14}} aria-label="Confirm booking details">
  <div style={{border:"1px solid #e8e3ef",borderRadius:"var(--paw-card-radius)",padding:18,background:"#fff"}}><small>BOOKING DETAILS</small><h3 style={{margin:"6px 0"}}>Confirm your details</h3><p>{service.name} · {service.subtitle}</p>{loading&&<p role="status">Loading your PawSpace profile…</p>}
   <label style={{display:"grid",gap:6,marginTop:12}}>Name *<input value={name} maxLength={60} onChange={e=>setName(e.target.value)} style={{padding:12,borderRadius:"var(--paw-card-radius)",border:"1px solid #d8d0e2"}}/></label>
   <label style={{display:"grid",gap:6,marginTop:12}}>Verified mobile<input value={customer.phone} disabled aria-label="Verified mobile" style={{padding:12,borderRadius:"var(--paw-card-radius)",border:"1px solid #d8d0e2"}}/><small>To use a different primary number, verify that number with OTP first.</small></label>
   <label style={{display:"grid",gap:6,marginTop:12}}>Alternate mobile <span>(optional)</span><input value={secondary} inputMode="numeric" maxLength={10} onChange={e=>setSecondary(e.target.value.replace(/\D/g,"").slice(0,10))} placeholder="Optional alternate number" style={{padding:12,borderRadius:"var(--paw-card-radius)",border:"1px solid #d8d0e2"}}/></label>
  </div>
  <AddressPicker initialAddress={initialAddress} autoLocate onZoneResolved={setLocation} summaryLabel="Booking service address"/>
  {error&&<p role="alert">{error}</p>}<button type="button" disabled={saving||loading||!location?.zone.serviceAvailable} onClick={()=>void proceed()} style={{padding:14,borderRadius:"var(--paw-card-radius)",border:0,fontWeight:800}}>{saving?"Saving details…":`Continue to ${service.name}`}</button>
 </section>;
}
