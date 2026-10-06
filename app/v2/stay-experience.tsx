"use client";
import Link from "next/link";
import {NativeServiceArt} from "../components/native-art";
import {useEffect,useState} from "react";
import StayFlow from "../mobile-app/stay-flow";
import StayGuestPreview from "./stay-guest-preview";
import {parseStayGuestDraft,stayGuestStorageKey,type StayGuestDraft} from "../../lib/v2/stay-guest-draft";
import {loadV2CustomerSession} from "../../lib/v2/customer-experience-client";
import {loadCustomerAccount} from "../../lib/customer-account-client";
import type {CustomerAccountRecord} from "../../lib/customer-account";
import styles from "./stay-experience.module.css";
import {plainErrorMessage} from "../../lib/safe-json-response";
type Mode="boarding"|"sitting";
const copy={boarding:{eyebrow:"TRUSTED STAYS",title:"A second home, connected to PawSpace.",body:"Boarding at a host’s home. Choose your pets and dates, then compare available homes and the exact stay price.",art:"/assets/pawspace-boarding-cartoon.webp"},sitting:{eyebrow:"CARE AT HOME",title:"Familiar spaces. Trusted company.",body:"Pet Sitting in your home. Plan a visit or overnight care around your pets’ familiar routine.",art:"/assets/pawspace-sitting-cartoon.webp"}};
export default function V2StayExperience({mode:initialMode}:{mode:Mode}){
 const[guestDraft,setGuestDraft]=useState<StayGuestDraft|null>(()=>{try{return parseStayGuestDraft(JSON.parse(window.sessionStorage.getItem(stayGuestStorageKey(initialMode))||"null"));}catch{return null;}});
 const[guest,setGuest]=useState(false);
 const updateDraft=(draft:StayGuestDraft)=>{setGuestDraft(draft);try{window.sessionStorage.setItem(stayGuestStorageKey(mode),JSON.stringify(draft));}catch{/* Keep preferences in this visit. */}};
 const clearDraft=()=>{setGuestDraft(null);try{window.sessionStorage.removeItem(stayGuestStorageKey(mode));}catch{/* A completed booking no longer reuses this in-memory draft. */}};
 const[mode,setMode]=useState<Mode>(initialMode),[account,setAccount]=useState<CustomerAccountRecord|null>(null),[attempt,setAttempt]=useState(0),[settledAttempt,setSettledAttempt]=useState(-1),[error,setError]=useState("");
 useEffect(()=>{let active=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);loadV2CustomerSession().then(session=>session?loadCustomerAccount(undefined,{signal:controller.signal}):null).then(record=>{if(active){setAccount(record);setGuest(!record);setError("");}}).catch(problem=>{if(active){setAccount(null);setGuest(false);setError(controller.signal.aborted?"Account loading timed out. Please retry.":plainErrorMessage(problem,"Unable to load your account."));}}).finally(()=>{clearTimeout(timer);if(active)setSettledAttempt(attempt);});return()=>{active=false;clearTimeout(timer);controller.abort();};},[attempt]);
 const loading=settledAttempt!==attempt,c=copy[mode];
 return <main className={styles.page}><div className={styles.shell}><header className={styles.nav}><Link href="/v2" className={styles.brand}><img src="/assets/pawspace-icon.jpeg" alt=""/><span>PawSpace</span></Link><Link href="/v2" className={styles.back}>← Home</Link></header><section className={styles.hero}><div><small>{c.eyebrow}</small><h1>{c.title}</h1><p>{c.body}</p><div className={styles.modeSwitch}><Link href="/v2/boarding" aria-current={mode==="boarding"?"page":undefined} className={mode==="boarding"?undefined:styles.ghost}>Boarding · host’s home</Link><Link href="/v2/sitting" aria-current={mode==="sitting"?"page":undefined} className={mode==="sitting"?undefined:styles.ghost}>Sitting · your home</Link></div></div><div className={styles.art}><NativeServiceArt service={mode==="boarding"?"boarding":"pet_sitting"} informative className={styles.heroScene}/></div></section>
 <section className={styles.surface}>{loading?<p role="status">Loading your PawSpace family…</p>:account?<StayFlow routeScope="v2" key={mode+":"+account.customerId} initialGuestDraft={guestDraft||undefined} onGuestDraftConsumed={clearDraft} mode={mode} onModeChange={next=>{setMode(next);window.location.assign(`/v2/${next}`);}} customer={{customerId:account.customerId,customerName:account.name,phone:account.primaryPhone}}/>:guest?<StayGuestPreview mode={mode} draft={guestDraft} onChange={updateDraft} onVerified={()=>setAttempt(x=>x+1)}/>:<div className={styles.login}><h2>Care account unavailable</h2><p role="alert">{error}</p><button onClick={()=>setAttempt(x=>x+1)}>Retry account</button></div>}</section></div>
 <nav className={styles.dock} aria-label="PawSpace V2 navigation"><Link href="/v2"><strong>⌂</strong>Home</Link><Link href={mode==="boarding"?"/v2/boarding":"/v2/sitting"} className={styles.active}><strong>＋</strong>Book</Link><Link href="/v2/chat"><strong>✦</strong>AI</Link><Link href="/v2/activity"><strong>◎</strong>Activity</Link></nav></main>;
}