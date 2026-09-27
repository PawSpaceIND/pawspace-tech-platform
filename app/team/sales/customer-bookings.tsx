"use client";
import{useEffect,useState}from"react";
import styles from"./sales.module.css";

/* The booking list in the Customer 360 detail. [round-2: the screen showed a booking COUNT only, so a rep
 * on a call could not say which booking, when, or whether it was paid.] The customer list read carries no
 * payment state (its fan-out budget); the selected customer's own read does, so the rows show each booking
 * straight away and add its payment state when that read answers. */
export type CustomerBooking={id:string;serviceCode:string;packageName:string;status:string;scheduledStart:string;totalAmount:number;currency:string;payment?:{status:string;label:string}|null};
export type PaymentView="loading"|"ready"|"unavailable";

const SERVICE_LABEL:Record<string,string>={grooming:"Grooming",dog_training:"Dog Training",boarding:"Boarding",pet_sitting:"Pet Sitting",pet_taxi:"Pet Taxi",dog_walking:"Dog Walking",food:"Fresh Food",pet_food:"Pet food",vet_consult:"Vet Consultation"};
const sentence=(value:string)=>{const text=String(value||"").replaceAll("_"," ").trim();return text?text[0].toUpperCase()+text.slice(1):"—";};
export const serviceLabel=(code:string)=>SERVICE_LABEL[code]??sentence(code);
/** Booking times are stored as instants; staff read them in IST whatever the browser's zone. */
export function istDateTime(value:string){const at=new Date(value);return Number.isFinite(at.getTime())?`${at.toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"})} IST`:value||"—";}
const SHOWN=8;
const STILL_OWED=/due|failed|awaiting|authorised/i;

/** The selected customer's bookings, each with its payment state. */
export async function loadCustomerBookings(customerId:string,request:typeof fetch=fetch):Promise<CustomerBooking[]>{
 const response=await request(`/api/customer-360?customerId=${encodeURIComponent(customerId)}`,{cache:"no-store"});
 const body=await response.json() as {data?:{records?:Array<{bookings?:CustomerBooking[]}>};error?:string};
 if(!response.ok)throw new Error(body.error||"Payment state unavailable");
 return body.data?.records?.[0]?.bookings||[];
}

export function CustomerBookingList({bookings,payments}:{bookings:CustomerBooking[];payments:PaymentView}){
 const[all,setAll]=useState(false);
 if(!bookings.length)return<p style={{color:"var(--staff-muted)"}}>No bookings yet.</p>;
 const shown=all?bookings:bookings.slice(0,SHOWN);
 return<div className={styles.bookingList}><ul aria-label="Bookings">{shown.map(booking=>{
  const payment=payments==="loading"?"Checking payment…":payments==="ready"&&booking.payment?booking.payment.label:"Payment state unavailable";
  return<li key={booking.id}><div><strong>{serviceLabel(booking.serviceCode)}</strong>{booking.packageName?` · ${booking.packageName}`:""}<small>{istDateTime(booking.scheduledStart)} · {sentence(booking.status)}</small></div><div><b>₹{Number(booking.totalAmount||0).toLocaleString("en-IN")}</b><small data-owed={payments==="ready"&&STILL_OWED.test(payment)?"true":undefined}>{payment}</small></div></li>;
 })}</ul>{bookings.length>SHOWN&&<button type="button" onClick={()=>setAll(value=>!value)} style={{display:"block",width:"100%",padding:10,marginBottom:16,border:"1px solid var(--staff-line)",borderRadius:10,background:"var(--staff-raised)",fontWeight:700}}>{all?"Show fewer bookings":`Show all ${bookings.length} bookings`}</button>}</div>;
}

export default function CustomerBookings({customerId,bookings}:{customerId:string;bookings:CustomerBooking[]}){
 const[detail,setDetail]=useState<{customerId:string;bookings:CustomerBooking[]|null}>({customerId:"",bookings:null});
 useEffect(()=>{let active=true;loadCustomerBookings(customerId).then(rows=>{if(active)setDetail({customerId,bookings:rows})},()=>{if(active)setDetail({customerId,bookings:null})});return()=>{active=false}},[customerId]);
 const answered=detail.customerId===customerId;
 return answered&&detail.bookings?<CustomerBookingList bookings={detail.bookings} payments="ready"/>:<CustomerBookingList bookings={bookings} payments={answered?"unavailable":"loading"}/>;
}
