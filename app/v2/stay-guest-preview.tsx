"use client";
import {useEffect,useState} from 'react';
import CustomerLogin from '../mobile-app/customer-login';
import {fetchOrExplain,readJsonBody} from '../../lib/safe-json-response';
import {defaultStayGuestDraft,parseStayGuestDraft,type StayGuestDraft} from '../../lib/v2/stay-guest-draft';
type Package={package_code:string;name:string;base_price_per_pet:number;currency:string};
export default function StayGuestPreview({mode,draft,onChange,onVerified}:{mode:'boarding'|'sitting';draft:StayGuestDraft|null;onChange:(draft:StayGuestDraft)=>void;onVerified:()=>void}){
 const [initial]=useState(defaultStayGuestDraft),values=draft||initial;
 const [packages,setPackages]=useState<Package[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true),[verify,setVerify]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{let active=true;const controller=new AbortController();void fetchOrExplain(mode==='boarding'?'/api/boarding-commercial':'/api/sitting-commercial',{cache:'no-store',signal:controller.signal},'browse care packages').then(async r=>{const body=await readJsonBody<{data?:{packages:Package[]};error?:string}>(r);if(!r.ok||!Array.isArray(body?.data?.packages))throw Error(body?.error||'Care catalogue is unavailable. Please retry.');if(active)setPackages(body.data.packages);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Unable to load care catalogue.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;controller.abort();};},[mode,retry]);
 const update=(next:Partial<StayGuestDraft>)=>{onChange({...values,...next});setVerify(false);};
 const valid=Boolean(parseStayGuestDraft(values));
 const input={width:'100%',minHeight:44,padding:10,border:'1px solid var(--brand-line)',borderRadius:'var(--paw-card-radius)',background:'var(--brand-surface)',color:'var(--brand-text)',font:'inherit'};
 return <section aria-label={`Browse ${mode} as guest`}><h2>Plan care as a guest</h2><p>Explore published care and choose dates before verifying your mobile. Your pets, doorstep, availability and final price are checked after verification. Nothing is reserved here.</p>
 {loading&&<p role="status">Loading care catalogue…</p>}{error&&<p role="alert">{error} <button type="button" style={{minHeight:44}} onClick={()=>{setLoading(true);setError('');setRetry(n=>n+1);}}>Retry catalogue</button></p>}
 {!loading&&!error&&<><p>Catalogue preview for Bengaluru; your verified service address determines final care options and prices.</p><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,220px),1fr))',gap:12}}>{packages.map(p=><article key={p.package_code} style={{border:'1px solid var(--brand-line)',padding:16,borderRadius:'var(--paw-card-radius)'}}><h3>{p.name}</h3><p>{Number.isFinite(p.base_price_per_pet)&&p.base_price_per_pet>0&&/^[A-Z]{3}$/.test(p.currency)?new Intl.NumberFormat('en-IN',{style:'currency',currency:p.currency}).format(p.base_price_per_pet):'Price unavailable'}</p><small>Base price per pet. The final care window, pet count and service area determine your quote.</small></article>)}</div>{!packages.length&&<p>No published care packages are available in this preview.</p>}</>}
 <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,220px),1fr))',gap:12,margin:'20px 0'}}>
 {mode==='sitting'&&<label>Care type<select style={input} value={values.sittingCare} onChange={e=>update({sittingCare:e.target.value as StayGuestDraft['sittingCare']})}><option value="visit">Home visit</option><option value="overnight">Overnight</option></select></label>}
 <label>{mode==='sitting'&&values.sittingCare==='visit'?'Visit date':'Check-in date'}<input type="date" style={input} value={values.start} onChange={e=>update({start:e.target.value})}/></label><label>Start time<input type="time" style={input} value={values.startTime} onChange={e=>update({startTime:e.target.value})}/></label>
 {!(mode==='sitting'&&values.sittingCare==='visit')&&<><label>Check-out date<input type="date" style={input} value={values.end} onChange={e=>update({end:e.target.value})}/></label><label>End time<input type="time" style={input} value={values.endTime} onChange={e=>update({endTime:e.target.value})}/></label></>}
 </div>{!valid&&<p role="alert">Choose valid dates in ascending order and valid times.</p>}
 <button type="button" style={{...input,width:'auto'}} disabled={!valid||loading||Boolean(error)||!packages.length} onClick={()=>{onChange(values);setVerify(true);}}>Continue with these care dates</button>
 {verify&&<section aria-label="Verify mobile before care booking"><h3>Verify your mobile</h3><p>Your care dates stay selected. We will then load your saved pets and review the exact care quote.</p><CustomerLogin embedded onLoggedIn={onVerified}/><button type="button" style={{minHeight:44}} onClick={()=>setVerify(false)}>Keep browsing</button></section>}
 </section>;
}
