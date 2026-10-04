"use client";
import Link from "next/link";
import {scopedBookingHref} from "../../lib/customer-booking-safety";
import type { SittingCarePlan } from '../../lib/sitting-lifecycle';
import BookingPaymentPage from './booking-payment-page';
import {hostRequestsExcludedNote} from '../../lib/boarding-host-requests';

type Props = {
  routeScope?:'legacy'|'v2'; mode: 'boarding' | 'sitting'; carePlan: SittingCarePlan;
  payment: { bookingId: string; serviceName: string; total: number; dueNow: number; mode: 'prepaid' | 'split_50_50' };
  onVerified: () => void;
  /** Boarding Care Card requests to the host: shown as not part of this payment. */
  hostRequests?: string[];
};
/** Payment and care are separate: required care still blocks server-side check-in. */
export default function StayCarePaymentGate({mode,payment,onVerified,routeScope="legacy",hostRequests=[]}:Props){
 const requestsNote=hostRequestsExcludedNote(hostRequests,'this payment');
 return <><p>Booking reference: <b>{payment.bookingId}</b> · <Link href={scopedBookingHref(mode,payment.bookingId,routeScope==="v2")}>Saved booking and Care Card</Link></p>
 <p>Complete payment first, then add your Care Card. Vet and emergency contacts{mode==='sitting'?' and home access':''} must be saved before service starts; your caregiver cannot check in without them.</p>
 {requestsNote&&<p>{requestsNote}</p>}
 <BookingPaymentPage returnAfterVerified={false} serviceName={payment.serviceName} bookingId={payment.bookingId} totalAmount={payment.total} amountDueNow={payment.dueNow} mode={payment.mode} onVerified={onVerified}/></>;
}
