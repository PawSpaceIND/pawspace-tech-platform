"use client";
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {loadVerifiedBookingReference,type RecoverableService} from '../../lib/booking-reference-recovery';
import type {CustomerConfirmationProjection} from '../../lib/customer-checkout-client';
import {scopedBookingHref} from '../../lib/customer-booking-safety';
type Props={bookingId:string;service:RecoverableService;routeScope?:'legacy'|'v2';className?:string};
function Recovery({bookingId,service,routeScope='legacy',className}:Props){
 const [attempt,setAttempt]=useState(0),[settled,setSettled]=useState(-1),[data,setData]=useState<CustomerConfirmationProjection|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  loadVerifiedBookingReference(bookingId,service,controller.signal).then(value=>{if(active){setData(value);setError('');}}).catch(problem=>{if(active){setData(null);setError(controller.signal.aborted?'Booking verification timed out. Please retry.':problem instanceof Error?problem.message:'The booking could not be verified.');}}).finally(()=>{clearTimeout(timer);if(active)setSettled(attempt);});
  return()=>{active=false;clearTimeout(timer);controller.abort();};
 },[bookingId,service,attempt]);
 const v2=routeScope==='v2',loading=settled!==attempt;
 if(loading)return <section className={className} aria-label="Booking reference verification"><h2>Checking your booking reference</h2><p role="status">Verifying the booking against your signed-in account. No new booking or payment is being created.</p></section>;
 if(!data)return <section className={className} aria-label="Booking reference verification"><h2>We could not verify this booking</h2><p role="alert">{error}</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>Retry booking verification</button><p><Link href={v2?'/v2/activity':'/mobile-app'}>Open your Activity</Link></p></section>;
 return <section className={className} aria-label="Verified saved booking"><h2>Your {service==='taxi'?'Taxi booking':'stay request'} is saved</h2><p>{data.packageName} · {data.bookingId}</p><p>Booking status: {data.bookingStatus.replaceAll('_',' ')}. Payment status: {data.paymentStatus||'Not available'}.</p><p>Review your saved care and payment before trying again. This status read does not confirm a payment.</p><Link href={scopedBookingHref(service,data.bookingId,v2)}>Open saved service and requests</Link><p><Link href={v2?`/v2/booking?bookingId=${encodeURIComponent(data.bookingId)}`:`/mobile-app/booking-confirmation?bookingId=${encodeURIComponent(data.bookingId)}`}>View booking and payment status</Link></p></section>;
}
export default function BookingReferenceRecovery(props:Props){return <Recovery key={props.service+':'+props.bookingId} {...props}/>;}
