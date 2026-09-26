"use client";
import{useEffect,useId,useRef,useState,type FormEvent}from"react";
import{customerAddressIssue}from"../../lib/customer-account";
import{resolveAddress,searchAddresses,type AddressSuggestion}from"../../lib/address-autocomplete-client";
import{addressFromResolvedPlace,addressFromSuggestionText,type AccountAddressFill}from"../../lib/account-address-search";
import{createAddressSessionToken}from"../../lib/grooming-booking-calendar";
import{resolveServiceCoverage,ServiceCoverageRefusal,type ResolvedServiceCoverage}from"../../lib/service-zone-client";
import{serviceAddressConflict}from"../../lib/service-address-consistency";
import styles from"./account-address-form.module.css";
/** The saved-address fields a host writes with upsert_address; the host adds isDefault and the idempotency key. */
export type AccountAddressInput={id?:string;label:string;line1:string;line2:string|null;area:string|null;city:string;postalCode:string};
export type AccountAddressRow={id?:string;label?:string|null;line1?:string|null;line2?:string|null;area?:string|null;city?:string|null;postalCode?:string|null};
type Fields={label:string;line1:string;line2:string;area:string;city:string;postalCode:string};
const fieldsFrom=(row?:AccountAddressRow):Fields=>({label:row?.label||"Home",line1:row?.line1||"",line2:row?.line2||"",area:row?.area||"",city:row?.city||"Bengaluru",postalCode:row?.postalCode||""});
const SEARCH_UNAVAILABLE="Address search is unavailable right now. Type the address below.";
// "Not served" only when the server refused the PIN; a failed check (network, 500, a non-JSON page) says so instead.
const NOT_SERVED="PawSpace doesn't serve this PIN yet. You can still save it; bookings check coverage.";
const COVERAGE_UNCHECKED="We couldn't check coverage for this PIN right now. You can still save it; bookings check coverage.";
/** A saved address without a PIN cannot be booked from. The fix loads that row, with its id, into the form,
 *  so saving updates it in place instead of adding a second row. */
export function MissingPin({onAdd,disabled}:{onAdd:()=>void;disabled?:boolean}){return <p className={styles.missing}>PIN code missing: add it to book Training and stays<button type="button" className={styles.secondary} onClick={onAdd} disabled={disabled}>Add PIN code</button></p>;}
/** Shared account address editor (the PetManager pattern): Google Places search on the existing autocomplete
 *  client above plain, always-editable fields. The host's onSave performs the write. Nothing is requested
 *  until the customer types or chooses, and manual entry works whenever Maps does not. */
export default function AccountAddressForm({busy,submitLabel="Save address",initial,onSave,onCancel}:{busy:boolean;submitLabel?:string;initial?:AccountAddressRow;onSave:(address:AccountAddressInput)=>Promise<void>;onCancel?:()=>void}){
 const[fields,setFields]=useState(()=>fieldsFrom(initial)),[id,setId]=useState(initial?.id||""),[query,setQuery]=useState(""),[suggestions,setSuggestions]=useState<AddressSuggestion[]>([]),[lookup,setLookup]=useState<""|"search"|"choose">(""),[searchNote,setSearchNote]=useState(""),[pinHint,setPinHint]=useState(""),[coverage,setCoverage]=useState<ResolvedServiceCoverage|null>(null),[coverageNote,setCoverageNote]=useState<{pincode:string;text:string}|null>(null),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 const session=useRef(""),generation=useRef(0),timer=useRef<number|undefined>(undefined),pinInput=useRef<HTMLInputElement>(null),searchId=useId();
 const sessionToken=()=>session.current||(session.current=createAddressSessionToken());
 useEffect(()=>()=>{generation.current+=1;window.clearTimeout(timer.current);},[]);
 const set=(key:keyof Fields,value:string)=>setFields(current=>({...current,[key]:value}));
 function search(value:string){
  const request=++generation.current;window.clearTimeout(timer.current);setQuery(value);setSuggestions([]);setSearchNote("");setLookup("");
  if(value.trim().length<3)return;
  timer.current=window.setTimeout(()=>{setLookup("search");void searchAddresses(value.trim(),sessionToken()).then(result=>{if(request!==generation.current)return;if(result.status!=="configured"){setSearchNote(SEARCH_UNAVAILABLE);return;}const next=result.suggestions.filter(s=>Boolean(s.placeId&&s.fullText));setSuggestions(next);if(!next.length)setSearchNote("No Google suggestions for that. Type the address below.");},()=>{if(request===generation.current)setSearchNote(SEARCH_UNAVAILABLE);}).finally(()=>{if(request===generation.current)setLookup("");});},250);
 }
 async function choose(suggestion:AddressSuggestion){
  const request=++generation.current;window.clearTimeout(timer.current);setLookup("choose");setSuggestions([]);setSearchNote("");setPinHint("");setError("");setCoverage(null);setCoverageNote(null);
  let fill:AccountAddressFill|null=null;
  // A chained resolve can outlast the client's 8s deadline; a timeout or refusal falls back to the suggestion text.
  try{fill=addressFromResolvedPlace(await resolveAddress(suggestion.placeId,sessionToken()),suggestion);}catch{fill=null;}
  if(request!==generation.current)return;
  session.current=createAddressSessionToken();
  // A new choice replaces the address, its PIN and any earlier area; coverage refills the area when served.
  const next=fill||addressFromSuggestionText(suggestion);setQuery("");setFields(current=>({...current,line1:next.line1,area:"",postalCode:next.postalCode}));
  if(!next.postalCode){setLookup("");setPinHint("Add the PIN code for this address");pinInput.current?.focus();return;}
  try{const served=await resolveServiceCoverage(next.postalCode);if(request!==generation.current)return;setCoverage(served);setFields(current=>({...current,area:served.area||current.area,city:served.city||current.city}));setCoverageNote({pincode:next.postalCode,text:`PawSpace serves ${served.zoneName} (${served.area||served.city}).`});}
  catch(problem){if(request===generation.current)setCoverageNote({pincode:next.postalCode,text:problem instanceof ServiceCoverageRefusal?NOT_SERVED:COVERAGE_UNCHECKED});}
  finally{if(request===generation.current)setLookup("");}
 }
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy||saving)return;
  const address:AccountAddressInput={id:id||undefined,label:fields.label.trim()||"Home",line1:fields.line1.trim(),line2:fields.line2.trim()||null,area:fields.area.trim()||null,city:fields.city.trim()||"Bengaluru",postalCode:fields.postalCode.trim()};
  const issue=customerAddressIssue(address);if(issue){setError(issue.error);return;}
  const conflict=serviceAddressConflict([address.line1,address.line2,address.city].filter(Boolean).join(", "),coverage&&coverage.pincode===address.postalCode?coverage.city:address.city,address.postalCode);if(conflict){setError(conflict);return;}
  setError("");setSaving(true);
  try{await onSave(address);generation.current+=1;window.clearTimeout(timer.current);setFields(fieldsFrom());setId("");setQuery("");setSuggestions([]);setLookup("");setSearchNote("");setPinHint("");setCoverage(null);setCoverageNote(null);}
  catch(problem){setError(problem instanceof Error&&problem.message?problem.message:"We could not save this address.");}
  finally{setSaving(false);}
 }
 return <div className={styles.panel}>
  <h3 className={styles.title}>{id?"Update this saved address":"Add default address"}</h3>{id&&<p className={styles.hint}>Add its 6-digit PIN code and check the details. Saving makes it your default address.</p>}
  <div className={styles.search}><label className={styles.label} htmlFor={searchId}>Search your address</label><input id={searchId} className={styles.input} type="search" value={query} onChange={e=>search(e.target.value)} placeholder="Start typing your building or street" autoComplete="off" enterKeyHint="search"/>{lookup==="search"&&<p className={styles.hint} role="status">Searching Google Maps…</p>}{lookup==="choose"&&<p className={styles.hint} role="status">Filling in the address…</p>}{searchNote&&<p className={styles.hint} role="status">{searchNote}</p>}{suggestions.length>0&&<section className={styles.suggestions} aria-label="Google address suggestions">{suggestions.map(s=><button key={s.placeId} type="button" className={styles.suggestion} disabled={lookup==="choose"} onClick={()=>void choose(s)}><b>{s.mainText}</b><span>{s.secondaryText}</span></button>)}<p className={styles.attribution}>Suggestions from Google Maps</p></section>}</div>
  <form className={styles.form} onSubmit={submit}><label className={styles.label}>Label<input className={styles.input} value={fields.label} onChange={e=>set("label",e.target.value)} autoComplete="off"/></label><label className={styles.label}>Address<input className={styles.input} value={fields.line1} onChange={e=>set("line1",e.target.value)} required autoComplete="address-line1" placeholder="House number, building and street"/></label><label className={styles.label}>Flat, floor or landmark<input className={styles.input} value={fields.line2} onChange={e=>set("line2",e.target.value)} autoComplete="address-line2" placeholder="Optional"/></label><label className={styles.label}>Area<input className={styles.input} value={fields.area} onChange={e=>set("area",e.target.value)} placeholder="Area"/></label><label className={styles.label}>City<input className={styles.input} value={fields.city} onChange={e=>set("city",e.target.value)} required autoComplete="address-level2"/></label><label className={styles.label}>PIN code<input ref={pinInput} className={styles.input} value={fields.postalCode} onChange={e=>{set("postalCode",e.target.value.replace(/\D/g,"").slice(0,6));setPinHint("");}} required inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} autoComplete="postal-code" placeholder="560001" title="Enter a 6-digit PIN code" autoFocus={Boolean(initial?.id&&!initial.postalCode)}/></label>{pinHint&&<p className={styles.hint} role="status">{pinHint}</p>}{coverageNote&&coverageNote.pincode===fields.postalCode&&<p className={styles.note} role="status">{coverageNote.text}</p>}{error&&<p className={styles.error} role="alert">{error}</p>}<div className={styles.actions}><button className={styles.primary} disabled={busy||saving}>{busy||saving?"Saving…":submitLabel}</button>{onCancel&&<button type="button" className={styles.secondary} onClick={onCancel} disabled={saving}>Cancel</button>}</div></form>
 </div>;
}
