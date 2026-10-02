"use client";
import {useState} from "react";
import Link from "next/link";
import CustomerLogin from "../../mobile-app/customer-login";
import {groomingBundleForCount,type V2GroomingCatalogue,type V2GroomingPackage} from "../../../lib/v2/grooming-client";
import {subscriptionPackage,subscriptionSavings} from "../../../lib/v2/grooming-subscription-projection";
import styles from "./grooming.module.css";
const money=(value:number,currency:string)=>new Intl.NumberFormat('en-IN',{style:'currency',currency}).format(value);
export default function GroomingGuestPreview({catalogue,selectedCode,onSelect,onVerified}:{catalogue:V2GroomingCatalogue;selectedCode:string;onSelect:(code:string)=>void;onVerified:()=>void}){
 const [audience,setAudience]=useState<V2GroomingPackage['audience']>(()=>catalogue.packages.find(p=>p.code===selectedCode)?.audience||catalogue.packages.find(p=>p.code===catalogue.subscriptions?.find(plan=>plan.code===selectedCode)?.servicePackageCode)?.audience||'dog');
 const [verify,setVerify]=useState(false);
 const allPackages=[...catalogue.packages,...(catalogue.subscriptions||[]).flatMap(plan=>{const care=catalogue.packages.find(p=>p.code===plan.servicePackageCode);return care?plan.eligiblePetTypes.flatMap(species=>{const audience=species==="cat"?"cat":species==="dog"?"dog":null,pkg=audience?subscriptionPackage(plan,care,audience):null;return pkg?[pkg]:[];}):[];})];
 const chosen=allPackages.find(p=>p.code===selectedCode);
 return <main className={styles.page}><Link href="/v2" style={{display:"inline-flex",alignItems:"center",minHeight:44}}>← PawSpace home</Link><section className={styles.step}>
 <h1>Explore doorstep grooming</h1><p>Browse and choose a package as a guest. Verify your mobile to continue with your pets, address and live availability. Nothing is reserved while browsing.</p>
 <fieldset><legend>Care for</legend>{(['dog','cat','young'] as const).map(value=><label key={value} style={{display:'inline-flex',alignItems:'center',minHeight:44,padding:'0 12px'}}><input type="radio" name="guest-care" checked={audience===value} onChange={()=>setAudience(value)}/>{value==='young'?'Puppies & kittens':value==='cat'?'Cats':'Dogs'}</label>)}</fieldset>
 <div className={styles.packageGrid}>{allPackages.filter(p=>p.audience===audience).map(pkg=>{const bundle=groomingBundleForCount(pkg,1);return <button type="button" key={pkg.code} aria-pressed={selectedCode===pkg.code} className={`${styles.packageCard} ${selectedCode===pkg.code?styles.selectedPackage:''}`} style={{minHeight:44}} onClick={()=>onSelect(pkg.code)}><small>{pkg.subscription?"Subscription":"One-time booking"}</small><h2>{pkg.name}</h2><p>{pkg.description}</p><b>{bundle?money(bundle.price,bundle.currency):'Select your pet count after verification'}</b>{pkg.subscription&&<p>{pkg.subscription.sessions} {pkg.subscription.familyWallet?"shared credits":"credits"} · valid {pkg.subscription.validityValue} {pkg.subscription.validityUnit} · total plan price. {(()=>{const care=catalogue.packages.find(p=>p.code===pkg.subscription?.servicePackageCode),saving=care?subscriptionSavings(pkg,care):null;return saving===null?"":`Save ${money(saving,pkg.subscription.currency)} versus equivalent published one-time catalogue care. Actual single-visit prices can vary.`;})()}</p>}{bundle&&<small>{bundle.slotMinutes} minutes · one pet · catalogue price; final pricing is checked before booking.</small>}</button>;})}</div>
 {chosen&&<p role="status">Your choice: <b>{chosen.name}</b>. We will check that it suits your saved pets after verification.</p>}
 <button type="button" disabled={!chosen} className={styles.continue} style={{minHeight:44}} onClick={()=>setVerify(true)}>Continue with this package</button>
 {verify&&<section aria-label="Verify mobile to continue grooming"><h2>Verify your mobile</h2><p>Your selected package stays here while you verify.</p><CustomerLogin embedded onLoggedIn={onVerified}/><button type="button" style={{minHeight:44}} onClick={()=>setVerify(false)}>Keep browsing</button></section>}
 </section></main>;
}
