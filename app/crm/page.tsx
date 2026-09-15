"use client";
/* eslint-disable @next/next/no-img-element */
import Link from"next/link";import{FormEvent,useEffect,useMemo,useState}from"react";import styles from"./crm.module.css";import TestSyncPanel from"../components/test-sync-panel";import CriticalErrorBoundary from"../components/critical-error-boundary";import RevenueEnginePanel from"./revenue-engine-panel";import LiveChatPanel from"./live-chat-panel";
type View="customers"|"revenue"|"chat";
type Contact={id:string;name:string;initials:string;phone:string;secondary:string;area:string;pets:string;petMeta:string;stage:string;owner:string;source:string;lifetime:number|null;lifetimeBasis:string;latestBookingId:string|null;next:string;opportunity:string};
const nav:{id:View;label:string;icon:string}[]=[{id:"customers",label:"Customers & pets",icon:"◉"},{id:"revenue",label:"Revenue & CX engine",icon:"₹"},{id:"chat",label:"WhatsApp Live Chat",icon:"💬"}];
export function toContact(row:Record<string,unknown>):Contact{return{id:String(row.id),name:String(row.name),initials:String(row.name).split(" ").map(x=>x[0]).join("").slice(0,2).toUpperCase(),phone:String(row.primary_phone),secondary:row.secondary_phone?String(row.secondary_phone):"Not added",area:row.area?String(row.area):"Bengaluru",pets:row.pet_names?String(row.pet_names):"Pet",petMeta:row.pet_summary?String(row.pet_summary):"Profile to complete",stage:row.stage?String(row.stage):"New lead",owner:row.owner?String(row.owner):"Unassigned",source:row.source?String(row.source):"Website",lifetime:row.lifetime_value==null?null:Number(row.lifetime_value),lifetimeBasis:String(row.lifetime_value_basis||"unavailable"),latestBookingId:row.latest_booking_id?String(row.latest_booking_id):null,next:row.next_action?String(row.next_action):"Call within 10 minutes",opportunity:row.opportunity?String(row.opportunity):"Discover requirement"}}
/* SEGMENT NARROWING, kept out of the component so a test can run the real predicate.
 *
 * The label in the dropdown is display text; crm_contacts.stage is stored data, and the two are not
 * the same string. Every path that stores a follow-up contact - app/api/revenue-crm's seed pass and
 * scripts/uat-demo-seed.sql - writes "Follow-up", while app/admin's customer model spells the same
 * state "Follow-up due". stage is free text with no CHECK constraint, so either spelling can reach
 * this screen, and matching the label alone would leave the segment permanently empty.
 *
 * There is deliberately NO text matching here. Search is the server's (see the note in CrmPage), and
 * stage and lifetime value are the two fields this screen never masks. */
export const FOLLOW_UP_STAGES=["Follow-up","Follow-up due"];
/* THE "At risk" SEGMENT, same problem one row down. No writer anywhere stores the stage "At risk", so
 * matching the dropdown label kept the segment permanently empty. The platform already has a
 * definition of at-risk and it is not a stage string: lib/customer-business-view.ts:49 derives
 *   else if (segment === "Dormant") { risk = "At risk"; nextAction = "Win-back call"; }
 * and the seed agrees - UATD-CUS-6-CRM is stored with stage 'Dormant' and next_action 'Win-back call'.
 * So "At risk" is what the platform CALLS a Dormant customer, and this segment selects exactly the
 * stage the platform stores for it. "At risk" itself stays in the list for the same reason
 * FOLLOW_UP_STAGES carries two spellings: stage is free text with no CHECK constraint, so a record
 * spelled that way can still arrive here. */
export const AT_RISK_STAGES=["Dormant","At risk"];
export function visibleContacts(contacts:Contact[],segment:string){return contacts.filter(c=>segment==="All customers"||(segment==="Follow-up due"&&FOLLOW_UP_STAGES.includes(c.stage))||(segment==="High value"&&(c.lifetime??0)>20000)||(segment==="At risk"&&AT_RISK_STAGES.includes(c.stage)))}

/* THE PANEL MUST SHOW A CUSTOMER THE LIST IS ACTUALLY SHOWING. The selection used to be resolved
 * against the WHOLE contact set first - `contacts.find(c=>c.id===selectedId)||filtered[0]||contacts[0]`
 * - so the first branch always hit and the panel never re-scoped when the segment changed: with
 * "At risk" the list rendered "0 shown" and nothing else while the panel still showed the previously
 * selected customer, complete with a live "Book this customer" link pointing at
 * /assisted-booking?customerId=<that customer>. An operator working the segment could open a booking
 * for a person who is not on the screen. The selection lives inside the NARROWED list now: if the
 * segment matches nothing, nothing is selected and the panel says so. Exported, like visibleContacts,
 * so the real predicate is what a test runs. */
export function selectedContact(visible:Contact[],selectedId:string){return visible.find(c=>c.id===selectedId)||visible[0]||null}

/* THREE DIFFERENT EMPTY LISTS, THREE DIFFERENT SENTENCES. "No CRM contacts yet. Use Add lead to create
 * the first record." was printed whenever contacts.length===0, which is also what a SEARCH THAT MATCHED
 * NOTHING looks like: an operator checking whether a caller already exists was told the CRM is empty and
 * invited to create the duplicate they were trying to avoid. A segment that narrows everything away is a
 * third state again - the records are loaded and listed, just not in this segment. */
export function listEmptyState(input:{contacts:number;visible:number;query:string;segment:string}):string|null{
  if(input.contacts===0)return input.query
    ?`No CRM contact matches “${input.query}”. This caller is not in the CRM yet — clear the search to see every record before you add a duplicate.`
    :"No CRM contacts yet. Use “Add lead” to create the first record.";
  if(input.visible===0)return `No customers in the “${input.segment}” segment. ${input.contacts} record${input.contacts===1?"":"s"} ${input.query?"match this search":"loaded"} — choose “All customers” to see them.`;
  return null;
}

export default function CrmPage(){const[view,setView]=useState<View>("customers");const[contacts,setContacts]=useState<Contact[]>([]);const[selectedId,setSelectedId]=useState("");const[loading,setLoading]=useState(true);const[loadError,setLoadError]=useState("");const[search,setSearch]=useState("");const[query,setQuery]=useState("");const[segment,setSegment]=useState("All customers");const[refreshToken,setRefreshToken]=useState(0);const[modal,setModal]=useState(false);const[toast,setToast]=useState("");const notify=(m:string)=>{setToast(m);setTimeout(()=>setToast(""),2300)};
/* SEARCH BELONGS TO THE SERVER. The list is capped at 100 by updated_at, so filtering the fetched
 * array could never find a lead outside that page - the reported "lead not found in CRM". The typed
 * query therefore goes to the server (debounced, so typing is not a request per key), which searches
 * name, phone, email, pet and id across the whole table against the RAW stored values.
 *
 * This note used to claim the client filter that ran afterwards was harmless. It was not. Rows arrive
 * with name and phone MASKED for display - "A•••• L• B•", "+91 ••••••0011" - so re-matching the typed
 * text against them discarded every row the server had just matched: a customer name or a full
 * 10-digit number returned two contacts from the API and rendered none, while a pet name or the last
 * four digits (which survive masking) still worked. Nothing on the client filters on text now; only
 * the segment narrows the list, and it reads stage and lifetime value, which are never masked. */
useEffect(()=>{const id=setTimeout(()=>setQuery(search.trim()),250);return ()=>clearTimeout(id)},[search]);
useEffect(()=>{let active=true;fetch(`/api/crm${query?`?search=${encodeURIComponent(query)}`:""}`,{cache:"no-store"}).then(async r=>{const body=await r.json().catch(()=>({})) as {contacts?:Array<Record<string,unknown>>;error?:string};if(!r.ok)throw new Error(body.error||"CRM records could not load - check your access");return body.contacts||[]}).then(rows=>{if(!active)return;const saved=rows.map(toContact);setContacts(saved);setSelectedId(current=>current||saved[0]?.id||"");setLoadError("")}).catch(e=>{if(active)setLoadError(e instanceof Error?e.message:"CRM records could not load")}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[query,refreshToken]);
const filtered=useMemo(()=>visibleContacts(contacts,segment),[contacts,segment]);
const selected=useMemo(()=>selectedContact(filtered,selectedId),[filtered,selectedId]);
async function addLead(e:FormEvent<HTMLFormElement>){e.preventDefault();const fd=new FormData(e.currentTarget);const body={name:String(fd.get("name")),primaryPhone:String(fd.get("phone")),petNames:String(fd.get("pet")),service:String(fd.get("service")),source:"Manual CRM",stage:"New lead",whatsappConsent:fd.get("whatsappConsent")==="yes",whatsappConsentSource:"staff_recorded_customer_request",whatsappConsentEvidence:String(fd.get("whatsappConsentEvidence")||"")};let id:string,assignedOwner:string,automationStatus:string;try{const res=await fetch("/api/crm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const data=await res.json().catch(()=>({})) as {id?:string;assignedOwner?:string;whatsappAi?:{status?:string};error?:string};if(!res.ok||!data.id){notify(data.error||"Unable to save lead - please try again");return;}id=data.id;assignedOwner=data.assignedOwner||"Unassigned";automationStatus=String(data.whatsappAi?.status||"blocked");}catch{notify("Unable to save lead - check your connection and try again");return;}
  /* THE SAVED ROW IS THE SERVER'S ROW. This built the new row out of the FORM values, so the list drew
   * the raw typed name and the raw 10-digit number - the full name, the full number - next to every other
   * row, which the server had already masked to "A••••• R•" and "+91 ••••••3016". The raw values stayed on
   * screen until the next reload, and the fabricated row also invented owner/stage/next-action fields
   * the server had not confirmed. The POST answers with the record's id; the record itself is read back
   * through the same list endpoint every other row comes from, and rendered through the same toContact.
   * If the read-back cannot be made, no row is fabricated - the list is refreshed instead. */
  let saved:Contact|null=null;
  try{const res=await fetch(`/api/crm?search=${encodeURIComponent(id)}`,{cache:"no-store"});const data=await res.json().catch(()=>({})) as {contacts?:Array<Record<string,unknown>>};const row=(data.contacts||[]).find(entry=>String(entry.id||"")===id);if(res.ok&&row)saved=toContact(row);}catch{/* fall through to a list refresh */}
  if(saved)setContacts(x=>[saved as Contact,...x.filter(entry=>entry.id!==id)]);else setRefreshToken(token=>token+1);
  setSelectedId(id);setModal(false);setView("customers");notify(automationStatus==="queued"?`Lead saved${assignedOwner?` to ${assignedOwner}`:""} and WhatsApp AI response queued`:`Lead saved${assignedOwner?` to ${assignedOwner}`:""}; staff follow-up remains active`)}
const emptyState=loading||loadError?null:listEmptyState({contacts:contacts.length,visible:filtered.length,query,segment});
const title=nav.find(n=>n.id===view)?.label;
return <main className={styles.shell}><div style={{gridColumn:"1 / -1",padding:"8px 16px",background:"#fff4d9",fontSize:13}}>Legacy CRM screen. Lifetime value here is computed from recognised bookings, the same rule Customer 360 uses, so the two screens always agree. <Link href="/team/sales" style={{fontWeight:700}}>Open Team Sales</Link> for the canonical Customer 360 + Revenue Intelligence version.</div><aside className={styles.sidebar}><Link href="/admin" className={styles.brand}><img src="/assets/pawspace-logo.jpeg" alt="PawSpace"/><span>CRM</span></Link><div className={styles.workspace}><span>PAWSPACE WORKSPACE</span><strong>Bangalore Operations</strong></div><nav>{nav.map(n=><button key={n.id} className={view===n.id?styles.active:""} onClick={()=>setView(n.id)}><i>{n.icon}</i><span>{n.label}</span></button>)}</nav><div className={styles.integrations}><span>TEST SYSTEMS · PRODUCTION READY: NO</span><p><i></i> Customer records: persistent CRM database</p><p><i></i> Revenue engine: persistent UAT records</p><p className={styles.pending}><i></i> Live delivery integrations · locked</p></div></aside><section className={styles.main}><header><div><p>PAWSPACE CUSTOMER OPERATING SYSTEM</p><h1>{title}</h1></div><div><label>⌕<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search customer, phone or pet"/></label><button onClick={()=>setModal(true)}>＋ Add lead</button></div></header><TestSyncPanel surface="crm" />
{view==="revenue"&&<CriticalErrorBoundary name="CRM revenue table" resetHref="/crm"><RevenueEnginePanel notify={notify}/></CriticalErrorBoundary>}
{view==="chat"&&<CriticalErrorBoundary name="CRM live chat table" resetHref="/crm"><LiveChatPanel notify={notify}/></CriticalErrorBoundary>}
{view==="customers"&&<section className={styles.customerLayout}><div className={styles.customerList}><div className={styles.customerTools}><select value={segment} onChange={e=>setSegment(e.target.value)}><option>All customers</option><option>Follow-up due</option><option>High value</option><option>At risk</option></select><span>{filtered.length} shown</span></div>{loadError&&<p role="alert" style={{padding:14,color:"#8c2f22"}}>{loadError}</p>}{loading&&!loadError&&<p style={{padding:14}}>Loading CRM records…</p>}{emptyState&&<p role="status" style={{padding:14}}>{emptyState}</p>}{filtered.length>0&&<div className={styles.customerHead}><span>Customer</span><span>Relationship</span><span>Next best action</span></div>}<CriticalErrorBoundary name="CRM customer table" resetHref="/crm"><CustomerRows contacts={filtered} selectedId={selected?.id||""} onSelect={setSelectedId}/></CriticalErrorBoundary></div><aside className={styles.customer360}>{!selected?<p style={{padding:16}}>Select a customer to see the record.</p>:<><div className={styles.profileHead}><span>{selected.initials}</span><div><small>{selected.id}</small><h2>{selected.name}</h2><p>{selected.phone} · {selected.area}</p></div></div><div className={styles.overview}><div className={styles.petCard}><span>🐾</span><div><small>REGISTERED PETS</small><strong>{selected.pets}</strong><p>{selected.petMeta}</p></div></div><dl><div><dt>Primary number</dt><dd>{selected.phone}</dd></div><div><dt>Secondary</dt><dd>{selected.secondary}</dd></div><div><dt>Lead source</dt><dd>{selected.source}</dd></div><div><dt>Relationship owner</dt><dd>{selected.owner}</dd></div><div><dt>Stage</dt><dd>{selected.stage}</dd></div><div><dt>Lifetime value</dt><dd>{selected.lifetime==null?"Unavailable":`₹${selected.lifetime.toLocaleString("en-IN")}`}<br/><small style={{color:"#746b7d"}}>{selected.lifetimeBasis==="recognized_bookings"?"From recognised bookings":selected.lifetimeBasis==="unavailable"?"Bookings could not be read":"No recognised booking yet"}</small></dd></div><div><dt>Latest booking</dt><dd>{selected.latestBookingId||"No canonical booking yet"}</dd></div></dl></div><div className={styles.nextBar}><div><span>NEXT ACTION</span><strong>{selected.next}</strong></div><div style={{display:"flex",gap:12,alignItems:"center"}}><Link href={`/assisted-booking?customerId=${encodeURIComponent(selected.id)}`} style={{fontWeight:800,fontSize:13}}>Book this customer →</Link><Link href="/team/sales" style={{fontWeight:700,fontSize:13}}>Open canonical 360 →</Link></div></div></>}</aside></section>}
</section>{modal&&<div className={styles.modalBack}><form className={styles.modal} onSubmit={addLead}><button type="button" onClick={()=>setModal(false)}>×</button><span>NEW CRM LEAD</span><h2>Create customer opportunity</h2><label>Customer name<input name="name" required placeholder="Full name"/></label><label>Primary mobile<input name="phone" required placeholder="10-digit number"/></label><label>Pet name<input name="pet" required placeholder="Pet name"/></label><label>Interested service<select name="service"><option>Grooming</option><option>Dog Training</option><option>Boarding</option><option>Pet Sitting</option><option>Fresh Food</option><option>Pet Taxi</option><option>Dog Walking</option></select></label><label style={{display:"flex",gap:8,alignItems:"flex-start"}}><input name="whatsappConsent" value="yes" type="checkbox"/> Customer explicitly requested a WhatsApp response for this enquiry.</label><label>Consent evidence/reference<input name="whatsappConsentEvidence" placeholder="Call ID, message ID or written note reference"/></label><button type="submit">Save lead & create follow-up</button><small>WhatsApp starts only with explicit evidence and an approved template. Otherwise the staff task remains active.</small></form></div>}{toast&&<div className={styles.toast}>✓ {toast}</div>}</main>}

export function CustomerRows({contacts,selectedId,onSelect}:{contacts:Contact[];selectedId:string;onSelect:(id:string)=>void}){return <>{contacts.map(c=><button key={c.id} className={selectedId===c.id?styles.selectedCustomer:""} onClick={()=>onSelect(c.id)}><div className={styles.identity}><i>{c.initials}</i><div><strong>{c.name}</strong><small>{c.phone} · {c.area}</small></div></div><div><span className={`${styles.stage} ${styles[c.stage.replaceAll(" ","").toLowerCase()]||""}`}>{c.stage}</span><small>{c.pets} · {c.source}</small></div><div><strong>{c.next}</strong><small>{c.opportunity}</small></div></button>)}</>}
