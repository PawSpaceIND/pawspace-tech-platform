"use client";
import ProviderWorkspaceEntry from"../components/provider-workspace-entry";
import Link from"next/link";
import CaregiverConversation from "../mobile-app/caregiver-conversation";
import {usePathname} from"next/navigation";
import styles from"./sitting-workspace.module.css";

function careTime(value:unknown){const date=new Date(String(value||""));return Number.isNaN(date.getTime())?"Time unavailable":date.toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"});}
import{getDeviceLocation}from"../../lib/device-location-client";
import{useEffect,useRef,useState}from"react";
import{loadSittingLifecycle,updateSittingLifecycle,type SittingLifecycleBooking}from"../../lib/sitting-lifecycle-client";
import{intentOf,useIntentIdempotency}from"../../lib/use-intent-idempotency";
import{acceptAvailable,describeProviderOffer,windowEnded}from"../../lib/provider-offer-copy";

const careFields=[["feeding","Food and water routine"],["medication","Medication instructions from your vet"],["emergencyContact","Emergency contact"],["vet","Vet contact"],["homeAccess","Home access instructions"],["specialInstructions","Other care instructions"]] as const;
// SIT-02: door code / home access, the emergency contact and the vet stay with the customer until the booking is paid and this sitter has accepted it.
const WITHHELD_TEXT="Withheld until the booking is paid and you have accepted it. PawSpace releases home access, the emergency contact and the vet together at acceptance.";
const AWAITING=["confirmed","awaiting_provider_acceptance","reassignment_offered"],HELD=["assigned","in_progress"],CLOSED=["completed","cancelled","refunded"];
type Pet={name:string;species:string;breed:string|null};

export default function SittingWorkspace({bookingId}:{bookingId:string}){const intents=useIntentIdempotency("sitter");
 const pathname=usePathname(),inV2=pathname.startsWith("/v2/partner/sitter"),sitterBase=inV2?"/v2/partner/sitter":"/sitter",customerHref=inV2?"/v2/sitting":"/sitting",partnerHome=inV2?"/v2/partner":"/partner-app";
 const actionInFlight=useRef(false);
 const[booking,setBooking]=useState<SittingLifecycleBooking|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[recoveryReason,setRecoveryReason]=useState("");
 async function refresh(){if(!bookingId)return;try{setError("");const rows=await loadSittingLifecycle({bookingId});setBooking(rows[0]||null)}catch(e){setError(e instanceof Error?e.message:"Unable to load Sitting booking")}}
 useEffect(()=>{if(!bookingId)return;let active=true;void loadSittingLifecycle({bookingId}).then(rows=>{if(!active)return;setError("");setBooking(rows[0]||null)}).catch(e=>{if(active)setError(e instanceof Error?e.message:"Unable to load Sitting booking")});return()=>{active=false}},[bookingId]);
 async function act(action:"accept"|"check_in"|"care_event"|"check_out"|"decline"|"sitter_unavailable",extra:Record<string,unknown>={}){if(!bookingId||actionInFlight.current)return;const intent=intentOf([bookingId,action],extra);actionInFlight.current=true;setBusy(true);setError("");try{const location=action==="check_in"?await getDeviceLocation():{};await updateSittingLifecycle({bookingId,action,...location,idempotencyKey:intents.keyFor(intent),...extra});await refresh();intents.settle(intent)}catch(e){setError(e instanceof Error?e.message:"Unable to update Sitting booking");/* a refused action (e.g. an offer that expired meanwhile) reloads the state it was refused against, keeping the error visible */void loadSittingLifecycle({bookingId}).then(rows=>setBooking(rows[0]||null)).catch(()=>undefined)}finally{actionInFlight.current=false;setBusy(false)}}
 if(!bookingId)return <ProviderWorkspaceEntry eyebrow="PAWSPACE · PET SITTER" title="Sitter workspace" blurb="Open a Pet Sitting booking to accept the schedule, check in, log care events and check out." basePath="/sitter" demoBookingId="UATD-BK-SIT-1" demoLabel="demo sitting booking" customerHref="/sitting" customerLabel="Book a Pet Sitting service" opsHref="/team/operations/sitting" opsLabel="Operations → Sitting" />;
 if(error&&!booking)return <main className={styles.workspace}><h1>PawSpace Sitting workspace</h1><p role="alert">{error}</p><button onClick={()=>void refresh()}>Retry</button></main>;
 if(!booking)return <main className={styles.workspace}><h1>PawSpace Sitting workspace</h1><p>Loading canonical Sitting booking…</p></main>;
 const status=String(booking.status||"");
 const rawPlan=booking.carePlan?.plan,withheldRaw=(booking.carePlan as {withheldUntilAccepted?:unknown}|null|undefined)?.withheldUntilAccepted,withheld=Array.isArray(withheldRaw)?withheldRaw.map(String):[];
 const plan=rawPlan&&typeof rawPlan==="object"&&!Array.isArray(rawPlan)?rawPlan as Record<string,unknown>:null;
 // The server's offer view (lib/provider-offer-state.ts) is the authority. An older payload without it falls back to the booking status alone.
 const offer=booking.offer??(AWAITING.includes(status)?{state:"open",expiresAt:null}:HELD.includes(status)?{state:"accepted",expiresAt:null}:null);
 const past=status!=="in_progress"&&!CLOSED.includes(status)&&windowEnded(booking.scheduled_end,booking.scheduled_start),bucket=past?"past":undefined;
 const offerCopy=describeProviderOffer(offer,{noun:"booking",bucket});
 const canAccept=AWAITING.includes(status)&&acceptAvailable(offer,bucket);
 const holdsJob=!past&&(offer?.state==="open"||HELD.includes(status))&&!CLOSED.includes(status)&&status!=="reassignment_needed";
 const pets=(Array.isArray(booking.pets)?booking.pets:[]) as Pet[];
 const location=booking.serviceLocation,navigationHref=location?`https://www.google.com/maps/dir/?${new URLSearchParams({api:"1",destination:`${location.latitude},${location.longitude}`,travelmode:"driving"})}`:"";
 return <main className={styles.workspace}><header><Link href={customerHref}>PawSpace</Link><strong>Sitting provider workspace</strong><Link href={partnerHome}>← Partner app</Link></header><section>
  <p>Pet Sitting booking · {String(booking.package_name||"Pet Sitting")}</p><h1>{booking.id}</h1>
  <div className={styles.offer} data-tone={offerCopy.tone} role="status" aria-label="Offer status"><strong>{offerCopy.label}</strong><p>{offerCopy.detail}</p></div>
  <p>Status: <strong>{status.replaceAll("_"," ")}</strong></p><p>Provider: {String(booking.provider_id||"")}</p>
  <h2>Care window</h2><p>Care starts: <strong>{careTime(booking.scheduled_start)}</strong></p><p>Care ends: <strong>{careTime(booking.scheduled_end)}</strong></p>
  <h2>Pets</h2>{pets.length?<ul aria-label="Pets in this booking">{pets.map((pet,index)=><li key={`${pet.name}-${index}`}><strong>{pet.name}</strong>{pet.species?` · ${pet.species}`:""}{pet.breed?` · ${pet.breed}`:""}</li>)}</ul>:<p>Pet details are not on this booking yet. Operations can add them from the booking record.</p>}
  {booking.carePlan?<p>Care plan: {String(booking.carePlan.status||"status unavailable").replaceAll("_"," ")}</p>:<p>Care plan: waiting for customer. Check-in opens once the customer submits it.</p>}<button disabled={busy} onClick={()=>void refresh()}>Refresh booking</button>
  {plan&&<div className={styles.carePlan} role="region" aria-label="Customer care instructions"><h2>Customer care instructions</h2>{withheld.length>0&&<p>{WITHHELD_TEXT}</p>}<dl>{careFields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{typeof plan[key]==="string"&&plan[key].trim()?String(plan[key]):withheld.includes(key)?"Shared once the booking is paid and you have accepted it":"Not provided"}</dd></div>)}</dl></div>}
  {error&&<p role="alert">{error}</p>}<p><Link href={`${sitterBase}/proof?bookingId=${encodeURIComponent(bookingId)}`}>Proof · medication · incident →</Link></p>
  {status==="reassignment_offered"&&offer?.state==="open"&&<p><strong>Recovery offer:</strong> Operations preserved the existing booking and paid care window. Accepting this offer does not create a new booking.</p>}
  <div role="region" aria-label="Service address and GPS" className={styles.carePlan}><h2>Service address &amp; GPS</h2>{location?<><p>{location.addressText}</p><p><a href={navigationHref} target="_blank" rel="noreferrer">Open navigation to this address</a></p><p>Use this accepted booking address for navigation. When you arrive, tap <strong>Check in with my location</strong> below: PawSpace verifies your live device location is within 250 m of the doorstep.</p></>:HELD.includes(status)?<p>You have accepted this booking, but its service address is not available yet. Contact PawSpace Operations before you travel.</p>:<p>The exact service address, navigation and GPS check-in become available after you accept the booking.</p>}</div>
  <div className={styles.actions} aria-busy={busy}>{canAccept&&<button disabled={busy} onClick={()=>void act("accept")}>{status==="reassignment_offered"?"Accept replacement booking":"Accept booking"}</button>}{status==="assigned"&&!past&&<button disabled={busy||!booking.carePlan} onClick={()=>void act("check_in")}>Check in with my location</button>}{status==="in_progress"&&<><button disabled={busy} onClick={()=>void act("care_event",{careEventType:"general_update",detail:{message:"Pets settled and care routine is on track"}})}>Log care update</button><button disabled={busy} onClick={()=>void act("care_event",{careEventType:"meal",detail:{message:"Meal completed"}})}>Log meal</button><button disabled={busy} onClick={()=>void act("check_out")}>Check out</button></>}</div>
  {holdsJob&&<form className={styles.recovery} onSubmit={event=>{event.preventDefault();if(recoveryReason.trim().length>=3)void act("sitter_unavailable",{reason:recoveryReason.trim()});}}><h2>Unable to provide this care?</h2><p>This alerts Operations to arrange a replacement for the same booking. Explain what happened so they can help the customer.</p><label htmlFor="sitter-recovery-reason">Reason you are unavailable</label><textarea id="sitter-recovery-reason" required minLength={3} value={recoveryReason} disabled={busy} onChange={event=>setRecoveryReason(event.target.value)} /><button disabled={busy||recoveryReason.trim().length<3}>Mark unavailable</button></form>}
  {status==="reassignment_needed"&&<p role="status">Operations recovery requested. The same booking is awaiting a replacement sitter.</p>}
  <CaregiverConversation key={bookingId} bookingId={bookingId} providerId={String(booking.provider_id)}/><h2>Care timeline</h2><ul>{(booking.events||[]).map((event,index)=><li key={String(event.id||index)}><strong>{String(event.event_type||"event")}</strong> · {careTime(new Date(Number(event.created_at||0)).toISOString())}</li>)}</ul></section></main>;
}
