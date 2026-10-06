"use client";
import {useState} from "react";
import Link from "next/link";
import CustomerLogin from "../../mobile-app/customer-login";
import {NativeServiceArt} from "../../components/native-art";
import {groomingBundleForCount,loadV2GroomingCatalogue,type V2GroomingCatalogue,type V2GroomingPackage} from "../../../lib/v2/grooming-client";
import {subscriptionPackage,subscriptionSavings} from "../../../lib/v2/grooming-subscription-projection";
import styles from "./grooming.module.css";
const money=(value:number,currency:string)=>new Intl.NumberFormat('en-IN',{style:'currency',currency,minimumFractionDigits:0,maximumFractionDigits:2}).format(value);
const AUDIENCE_LABEL:Record<V2GroomingPackage['audience'],string>={dog:'Dogs',cat:'Cats',young:'Puppies & kittens'};
/**
 * Signed-out entry to V2 grooming. The catalogue shown is exactly what the server published (the page loads it and
 * hands it over); nothing is invented when it is empty, refreshing, or fails to refresh. Verification of the mobile
 * number still precedes pets, address and live availability, and nothing is reserved while browsing.
 */
export default function GroomingGuestPreview({catalogue,selectedCode,onSelect,onVerified}:{catalogue:V2GroomingCatalogue;selectedCode:string;onSelect:(code:string)=>void;onVerified:()=>void}){
 const [audience,setAudience]=useState<V2GroomingPackage['audience']>(()=>catalogue.packages.find(p=>p.code===selectedCode)?.audience||catalogue.packages.find(p=>p.code===catalogue.subscriptions?.find(plan=>plan.code===selectedCode)?.servicePackageCode)?.audience||'dog');
 const [verify,setVerify]=useState(false);
 // A refresh asked for here (Retry) replaces the catalogue the page handed over; the page's own loading and fatal states are unchanged.
 const [refresh,setRefresh]=useState<{busy:boolean;error:string;override:V2GroomingCatalogue|null}>({busy:false,error:'',override:null});
 const live=refresh.override||catalogue;
 const allPackages=[...live.packages,...(live.subscriptions||[]).flatMap(plan=>{const care=live.packages.find(p=>p.code===plan.servicePackageCode);return care?plan.eligiblePetTypes.flatMap(species=>{const audience=species==="cat"?"cat":species==="dog"?"dog":null,pkg=audience?subscriptionPackage(plan,care,audience):null;return pkg?[pkg]:[];}):[];})];
 const shown=allPackages.filter(p=>p.audience===audience);
 const chosen=allPackages.find(p=>p.code===selectedCode);
 const nothingPublished=allPackages.length===0;
 const retry=async()=>{
  if(refresh.busy)return;
  setRefresh({busy:true,error:'',override:refresh.override});
  try{const next=await loadV2GroomingCatalogue({cityId:'blr'});setRefresh({busy:false,error:'',override:next});}
  catch(problem){setRefresh({busy:false,error:problem instanceof Error?problem.message:'We could not refresh the grooming packages.',override:refresh.override});}
 };
 return <main className={styles.page} data-v2-hero-page="true">
  <div className={styles.ambient}/>
  <header className={styles.nav} style={{gridTemplateColumns:'minmax(0,1fr) auto auto',gap:8}}>
   <Link href="/v2" className={styles.brand}><img src="/assets/pawspace-official-lockup.png" alt="PawSpace"/></Link>
   <div className={styles.guestAppearance} data-paw-appearance-slot="grooming-guest" data-paw-appearance-ready="true"/>
   <Link href="/v2" className={styles.close} aria-label="Close grooming preview">×</Link>
  </header>
  <div className={styles.backBar} aria-label="Previous step"><Link href="/v2">← Back to PawSpace</Link><span>Guest preview · verify to book</span></div>
  <section className={styles.hero}>
   <div>
    <span className={styles.eyebrow}>DOORSTEP GROOMING · V2</span>
    <h1>Explore doorstep grooming</h1>
    <p>Browse the published packages and choose one as a guest. Verify your mobile to continue with your pets, address and live availability. Nothing is reserved while browsing.</p>
   </div>
   <div className={styles.heroArt}><NativeServiceArt service="grooming" informative/></div>
  </section>
  <div className={styles.layout}>
   <div className={styles.journey} style={{gridColumn:'1 / -1'}}>
    <section className={styles.step} aria-labelledby="v2-guest-package-title">
     <div className={styles.stepHead}><span>01</span><div><small>CARE EDIT</small><h2 id="v2-guest-package-title">Choose a grooming ritual</h2></div></div>
     <fieldset style={{border:0,padding:0,margin:'0 0 12px',minWidth:0}}><legend className={styles.helper}>Care for</legend>
      <div className={styles.providerGrid}>{(['dog','cat','young'] as const).map(value=><label key={value} className={`${styles.providerCard} ${audience===value?styles.providerSelected:''}`} style={{cursor:'pointer'}}><input type="radio" name="guest-care" checked={audience===value} onChange={()=>setAudience(value)}/> <b>{AUDIENCE_LABEL[value]}</b></label>)}</div>
     </fieldset>
     {refresh.busy&&<p role="status" className={styles.helper}>Refreshing the published packages…</p>}
     {refresh.error&&<p role="alert" className={styles.inlineError}>{refresh.error} <button type="button" className={styles.liveButton} disabled={refresh.busy} onClick={()=>void retry()}>Retry</button></p>}
     {!refresh.busy&&nothingPublished&&<div className={styles.empty}><p>No grooming packages are published for this preview right now. Only published packages and prices are ever shown here.</p>{!refresh.error&&<button type="button" className={styles.liveButton} onClick={()=>void retry()}>Retry</button>}</div>}
     {!refresh.busy&&!nothingPublished&&shown.length===0&&<div className={styles.empty}>No published package for {AUDIENCE_LABEL[audience].toLowerCase()} right now. Choose another pet type above.</div>}
     {!refresh.busy&&shown.length>0&&<div className={styles.packageGrid}>{shown.map(pkg=>{const bundle=groomingBundleForCount(pkg,1),selected=selectedCode===pkg.code;return <button type="button" key={pkg.code} aria-pressed={selected} className={`${styles.packageCard} ${selected?styles.selectedPackage:''}`} onClick={()=>onSelect(pkg.code)}>
      <div className={styles.packageTop}><span>{pkg.subscription?"Subscription":"One-time"} · {AUDIENCE_LABEL[pkg.audience]}</span>{selected&&<strong>Selected</strong>}</div>
      <h3>{pkg.name}</h3>
      <p>{pkg.description}</p>
      {pkg.subscription&&<p>{pkg.subscription.sessions} {pkg.subscription.familyWallet?"shared credits":"credits"} · valid {pkg.subscription.validityValue} {pkg.subscription.validityUnit} · total plan price. {(()=>{const care=live.packages.find(p=>p.code===pkg.subscription?.servicePackageCode),saving=care?subscriptionSavings(pkg,care):null;return saving===null?"":`Save ${money(saving,pkg.subscription.currency)} versus equivalent published one-time catalogue care. Actual single-visit prices can vary.`;})()}</p>}
      <div className={styles.packageBottom}><b style={{whiteSpace:'nowrap',flexShrink:0}}>{bundle?money(bundle.price,bundle.currency):'Price after verification'}</b><small>{bundle?`${bundle.slotMinutes} min · one pet · published price; final pricing is checked before booking`:'Select your pet count after verification'}</small></div>
     </button>;})}</div>}
     {chosen&&<p role="status" className={styles.helper}>Your choice: <b>{chosen.name}</b>. We will check that it suits your saved pets after verification.</p>}
     <button type="button" disabled={!chosen||refresh.busy} className={styles.continue} onClick={()=>setVerify(true)}>Continue with this package <span>→</span></button>
     <small className={styles.footnote}>Verification comes before pets, address and live groomer availability. Nothing is reserved while browsing.</small>
     {verify&&<section aria-label="Verify mobile to continue grooming" className={styles.addressBox} style={{display:'block',marginTop:16}}><h2>Verify your mobile</h2><p>Your selected package stays here while you verify.</p><CustomerLogin embedded onLoggedIn={onVerified}/><button type="button" className={styles.liveButton} onClick={()=>setVerify(false)}>Keep browsing</button></section>}
    </section>
   </div>
  </div>
 </main>;
}
