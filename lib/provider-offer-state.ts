import{chunkedIn}from"./d1-chunked-in";
/**
 * One honest answer, shared by every partner surface, to "can this partner still accept this job, and
 * does it still belong on their active list?".
 *
 * Commission sitters, hosts and drivers receive a provider_assignment_offers row with an expiry
 * (acceptance_timeout_minutes, lib/provider-capacity-governance.ts). The lifecycle refuses an accept once
 * that offer has expired or moved to someone else (lib/sitting-lifecycle.ts, lib/boarding-stay-lifecycle.ts,
 * lib/taxi-lifecycle.ts), while the booking itself keeps saying "confirmed". Surfaces that read only the
 * booking status therefore offered an Accept button that could only fail, and counted jobs from weeks
 * ago as active work. This module reads the offer the same way the lifecycle does (pending AND
 * expires_at >= now is the only acceptable offer) so the screen and the server agree.
 */
type Row=Record<string,unknown>;

/** Where the booking is relative to the assigned partner's acceptance. Each service maps its own statuses. */
export type AcceptancePhase="unpaid"|"awaiting"|"accepted"|"in_service"|"recovery"|"closed";
/**
 * open       - the partner can accept now (expiresAt is the deadline, or null when no offer row governs it)
 * expired    - the offer ran out; Operations is arranging cover and Accept is refused
 * withdrawn  - the offer went to someone else or was cancelled/declined, or Operations is recovering the job
 * accepted   - this partner holds the job
 * awaiting_payment - the customer has not paid yet; there is nothing to accept
 * closed     - completed, cancelled or refunded
 */
export type ProviderOfferState="open"|"expired"|"withdrawn"|"accepted"|"awaiting_payment"|"closed";
export type ProviderOfferView={state:ProviderOfferState;expiresAt:number|null;offeredAt:number|null};
/** active counts as the partner's work; needs_operations and past never do. */
export type ProviderJobBucket="active"|"needs_operations"|"past"|"completed";

const CLOSED=new Set(["completed","cancelled","refunded","closed","no_show"]);
const IN_SERVICE=new Set(["in_progress","checked_in","on_the_way","arrived","in_service","picked_up","in_transit","arrived_dropoff","dropoff_confirmed"]);
const RECOVERY=new Set(["reassignment_needed","ops_escalation","recovery_needed"]);
const AWAITING=new Set(["confirmed","awaiting_provider_acceptance","awaiting_acceptance","awaiting_host_acceptance","reassignment_offered"]);

/**
 * Status -> phase. A Boarding STAY is the one record where "confirmed" means the host already accepted
 * (awaiting_host_acceptance -> confirmed -> in_progress) and recovery_pending is a replacement offer to
 * the reading host; everywhere else "confirmed" is a paid booking still waiting for its partner.
 */
export function acceptancePhase(status:unknown,options:{boardingStay?:boolean}={}):AcceptancePhase{
 const value=String(status||"").trim();
 if(CLOSED.has(value))return"closed";
 if(options.boardingStay){if(value==="awaiting_host_acceptance"||value==="recovery_pending")return"awaiting";if(value==="confirmed")return"accepted";}
 if(value==="payment_pending"||value==="pending_payment")return"unpaid";
 if(RECOVERY.has(value)||value==="recovery_pending")return"recovery";
 if(IN_SERVICE.has(value))return"in_service";
 if(AWAITING.has(value))return"awaiting";
 if(value==="assigned"||value==="accepted")return"accepted";
 return"awaiting";
}

const num=(value:unknown)=>{const parsed=Number(value);return value!=null&&value!==""&&Number.isFinite(parsed)?parsed:null;};

/** The partner-facing offer state for one booking, from its offer row (if any) and its acceptance phase. */
export function providerOfferView(offer:Row|null|undefined,input:{providerId:string;phase:AcceptancePhase;now?:number}):ProviderOfferView{
 const now=input.now??Date.now(),expiresAt=offer?num(offer.expires_at):null,offeredAt=offer?num(offer.offered_at):null,view=(state:ProviderOfferState)=>({state,expiresAt,offeredAt});
 if(input.phase==="closed")return view("closed");
 if(input.phase==="unpaid")return view("awaiting_payment");
 if(input.phase==="recovery")return view("withdrawn");
 if(input.phase==="accepted"||input.phase==="in_service")return view("accepted");
 // awaiting: exactly the checks the lifecycles make before they accept.
 if(!offer)return view("open");
 if(String(offer.provider_id||"")!==String(input.providerId||""))return view("withdrawn");
 const status=String(offer.status||"");
 if(status==="accepted")return view("accepted");
 if(status!=="pending")return view("withdrawn");
 if(expiresAt!==null&&expiresAt<now)return view("expired");
 return view("open");
}

/**
 * Which heading a job belongs under. A job whose care/stay/trip window has fully ended is Past unless the
 * partner is still mid-service (they must still be able to check out). Expired or withdrawn offers are
 * Operations' to resolve, not the partner's work.
 */
export function providerJobBucket(input:{phase:AcceptancePhase;offerState:ProviderOfferState;scheduledEnd:unknown;scheduledStart?:unknown;now?:number}):ProviderJobBucket{
 const now=input.now??Date.now();
 if(input.phase==="closed")return"completed";
 const end=Date.parse(String(input.scheduledEnd||"")),start=Date.parse(String(input.scheduledStart||"")),finishedAt=Number.isFinite(end)?end:Number.isFinite(start)?start:null;
 if(input.phase!=="in_service"&&finishedAt!==null&&finishedAt<now)return"past";
 if(input.offerState==="expired"||input.offerState==="withdrawn")return"needs_operations";
 return"active";
}

/** Only an open offer can be accepted; the Accept control renders for nothing else. */
export const canAcceptOffer=(offer:{state?:string}|null|undefined)=>offer?.state==="open";

/** Offers keyed by schedule group, one IN query per chunk. A missing table means no offer governs any job. */
export async function loadAssignmentOffers(db:D1Database,groupIds:unknown[]){
 const ids=[...new Set(groupIds.map(value=>String(value||"").trim()).filter(Boolean))],out=new Map<string,Row>();
 if(!ids.length)return out;
 try{for(const row of await chunkedIn(ids,async(chunk,placeholders)=>(await db.prepare(`SELECT group_id,provider_id,status,offered_at,expires_at FROM provider_assignment_offers WHERE group_id IN (${placeholders})`).bind(...chunk).all<Row>()).results??[]))out.set(String(row.group_id),row);}
 catch(error){if(!/no such table/i.test(error instanceof Error?error.message:String(error)))throw error;}
 return out;
}

/** The sanitized projection carried to partner clients: state and times only, never the offer row. */
export function projectOfferView(value:unknown):ProviderOfferView|null{
 if(!value||typeof value!=="object"||Array.isArray(value))return null;
 const row=value as Row,state=String(row.state||"");
 if(!["open","expired","withdrawn","accepted","awaiting_payment","closed"].includes(state))return null;
 return{state:state as ProviderOfferState,expiresAt:num(row.expiresAt),offeredAt:num(row.offeredAt)};
}
