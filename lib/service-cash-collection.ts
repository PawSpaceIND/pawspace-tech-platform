import{collectedForBooking}from"./collected-funds";
import{governedJsonError}from"./governed-http-error";

/**
 * Cash collection on a pay-after-service booking, and the one way past it.
 *
 * Owner decision 2026-09-22 (decision 7 of 10): on a pay-after-service booking a provider cannot mark
 * the job complete until the collection is recorded, UNLESS Operations authorises the completion with a
 * stored reason - and that override does not release the payout.
 *
 * The gap this closes: completion already wrote a `provider_settlement_readiness` row at status
 * 'accrued' - the provider's money, owed - and the only thing that ever created a payment link for a
 * pay-after-service booking (lib/grooming-payment-reconciliation.ts) refuses to run until the booking is
 * ALREADY completed. So the accrual was recorded first and the collection asked for afterwards, with
 * nothing between them. A job completed and never paid for accrued a payout all the same.
 *
 * What counts as collected is deliberately not re-invented here. `collectedForBooking` is the platform's
 * answer to "did money change hands" for gateway payments, and a recorded cash handover is the same
 * question answered for money that never touched the gateway. Either satisfies the gate.
 *
 * NOTHING HERE CAPTURES MONEY. Recording a cash collection records what the provider says they were
 * handed; it does not move a rupee, does not touch booking_payments.status, and is not a substitute for
 * the signature-verified gateway capture that remains the only thing allowed to mark a payment paid.
 */

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const round2=(value:number)=>Math.round(value*100)/100;

/** Payment modes where the customer pays after the service, so completion needs a collection first. */
export const PAY_AFTER_SERVICE_MODES=["pay_after_service"] as const;

/** Methods a provider can be handed money by, in person. A card or UPI capture is a gateway event. */
export const CASH_COLLECTION_METHODS=["cash","upi_to_provider","card_on_delivery"] as const;
export type CashCollectionMethod=typeof CASH_COLLECTION_METHODS[number];

export async function ensureServiceCashCollectionTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS service_cash_collections (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,reference TEXT,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}')"),
 db.prepare("CREATE TABLE IF NOT EXISTS service_completion_collection_overrides (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,reason TEXT NOT NULL,authorised_by TEXT NOT NULL,authorised_at INTEGER NOT NULL,payout_released INTEGER NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}')"),
]);}

/** Is this booking one the customer pays for after the service? */
export async function isPayAfterService(db:Db,bookingId:string){
 const payment=await db.prepare("SELECT mode FROM booking_payments WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 return (PAY_AFTER_SERVICE_MODES as readonly string[]).includes(text(payment?.mode));
}

/**
 * What the provider recorded being handed for this booking, if anything.
 */
export async function recordedCashCollection(db:Db,bookingId:string){
 await ensureServiceCashCollectionTables(db).catch(()=>{});
 const row=await db.prepare("SELECT booking_id,provider_id,amount,currency,method,reference,recorded_by,recorded_at FROM service_cash_collections WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 if(!row)return null;
 return{bookingId:text(row.booking_id),providerId:text(row.provider_id),amount:round2(Number(row.amount||0)),currency:text(row.currency)||"INR",method:text(row.method),reference:text(row.reference)||null,recordedBy:text(row.recorded_by),recordedAt:Number(row.recorded_at||0)};
}

/** The Operations authorisation that lets a completion through without one, if there is one. */
export async function collectionOverride(db:Db,bookingId:string){
 await ensureServiceCashCollectionTables(db).catch(()=>{});
 const row=await db.prepare("SELECT booking_id,provider_id,reason,authorised_by,authorised_at,payout_released FROM service_completion_collection_overrides WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 if(!row)return null;
 return{bookingId:text(row.booking_id),providerId:text(row.provider_id),reason:text(row.reason),authorisedBy:text(row.authorised_by),authorisedAt:Number(row.authorised_at||0),payoutReleased:Number(row.payout_released||0)===1};
}

/**
 * Record what the provider was handed. Not a capture: see the module comment.
 *
 * The amount is checked against the booking so a mistyped figure is refused rather than filed as the
 * truth of what the customer paid. Re-recording is allowed while the booking is still open, because a
 * provider who typed the wrong number must be able to correct it before they complete the job.
 */
export async function recordCashCollection(db:Db,input:{bookingId:string;providerId:string;amount:number;method:string;reference?:string|null;actorId:string}){
 await ensureServiceCashCollectionTables(db);
 const booking=await db.prepare("SELECT status,total_amount,currency FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
 if(!booking)throw governedJsonError({error:"Booking not found",code:"booking_not_found"},404);
 if(text(booking.status)==="completed")throw governedJsonError({error:"This job is already complete. A collection recorded afterwards would not have gated anything; ask Operations to reconcile the payment instead.",code:"collection_after_completion"},409);
 if(!(CASH_COLLECTION_METHODS as readonly string[]).includes(text(input.method)))throw governedJsonError({error:`Record how you were paid: ${CASH_COLLECTION_METHODS.join(", ")}.`,code:"collection_method_required"},400);
 const amount=round2(Number(input.amount)),due=round2(Number(booking.total_amount||0));
 if(!Number.isFinite(amount)||amount<=0)throw governedJsonError({error:"Enter the amount you collected.",code:"collection_amount_required"},400);
 if(amount>due)throw governedJsonError({error:`You cannot record more than the booking total of ${due}. Check the amount and try again.`,code:"collection_exceeds_booking",bookingTotal:due},409);
 const now=Date.now();
 await db.prepare("INSERT INTO service_cash_collections (booking_id,provider_id,amount,currency,method,reference,recorded_by,recorded_at,detail_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET amount=excluded.amount,currency=excluded.currency,method=excluded.method,reference=excluded.reference,recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at").bind(input.bookingId,input.providerId,amount,text(booking.currency)||"INR",text(input.method),text(input.reference)||null,input.actorId,now,JSON.stringify({bookingTotal:due,liveCapture:false,capturesMoney:false})).run();
 return{bookingId:input.bookingId,amount,currency:text(booking.currency)||"INR",method:text(input.method),recordedBy:input.actorId,recordedAt:now,bookingTotal:due,shortfall:round2(Math.max(0,due-amount)),capturesMoney:false as const};
}

/**
 * Operations authorises a completion that has no recorded collection.
 *
 * The reason is stored and is not optional, because this is the record of why a job was allowed to close
 * with the money unaccounted for. It never releases the payout - see assertCollectionRecordedForCompletion.
 */
export async function authoriseCompletionWithoutCollection(db:Db,input:{bookingId:string;reason:string;actorId:string}){
 await ensureServiceCashCollectionTables(db);
 const booking=await db.prepare("SELECT b.status,b.provider_id FROM canonical_bookings b WHERE b.id=?").bind(input.bookingId).first<Row>();
 if(!booking)throw governedJsonError({error:"Booking not found",code:"booking_not_found"},404);
 const reason=text(input.reason);
 if(reason.length<8)throw governedJsonError({error:"Record why this job may be completed with the collection unaccounted for. This reason is kept with the booking.",code:"override_reason_required"},400);
 const now=Date.now();
 await db.prepare("INSERT INTO service_completion_collection_overrides (booking_id,provider_id,reason,authorised_by,authorised_at,payout_released,detail_json) VALUES (?,?,?,?,?,0,?) ON CONFLICT(booking_id) DO UPDATE SET reason=excluded.reason,authorised_by=excluded.authorised_by,authorised_at=excluded.authorised_at,detail_json=excluded.detail_json").bind(input.bookingId,text(booking.provider_id),reason,input.actorId,now,JSON.stringify({payoutReleased:false,note:"Completion authorised without a recorded collection; the provider payout stays withheld."}).toString()).run();
 return{bookingId:input.bookingId,reason,authorisedBy:input.actorId,authorisedAt:now,payoutReleased:false as const};
}

export type CollectionGate={required:boolean;satisfied:boolean;via:"not_required"|"gateway_capture"|"recorded_collection"|"ops_override";payoutReleased:boolean;collected:number;overrideReason:string|null};

/**
 * The gate itself, called on the way into completion.
 *
 * Returns how the completion is allowed to proceed, or refuses. `payoutReleased` is the half that
 * matters afterwards: an override lets the job close, and only the job. The caller records the
 * settlement as withheld rather than accrued, so authorising a completion never quietly authorises a
 * payment to the provider as well.
 */
export async function assertCollectionRecordedForCompletion(db:Db,input:{bookingId:string;providerId:string}):Promise<CollectionGate>{
 if(!await isPayAfterService(db,input.bookingId))return{required:false,satisfied:true,via:"not_required",payoutReleased:true,collected:0,overrideReason:null};
 await ensureServiceCashCollectionTables(db);
 const collected=await collectedForBooking(db,input.bookingId).catch(()=>0);
 if(collected>0)return{required:true,satisfied:true,via:"gateway_capture",payoutReleased:true,collected,overrideReason:null};
 const recorded=await recordedCashCollection(db,input.bookingId);
 if(recorded&&recorded.amount>0)return{required:true,satisfied:true,via:"recorded_collection",payoutReleased:true,collected:recorded.amount,overrideReason:null};
 const override=await collectionOverride(db,input.bookingId);
 if(override)return{required:true,satisfied:true,via:"ops_override",payoutReleased:false,collected:0,overrideReason:override.reason};
 throw governedJsonError({
  error:"Record the payment you collected before completing this job. This booking is pay-after-service, so nothing has been collected yet. If the customer has not paid, Operations can authorise the completion - your payout stays on hold until the payment is accounted for.",
  code:"cash_collection_required",
  bookingId:input.bookingId,
  methods:CASH_COLLECTION_METHODS,
 },409);
}
