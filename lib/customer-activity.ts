export type ActivityBooking={id:string;serviceCode:string;scheduledStart:string;status:string};
const terminal=new Set(['completed','cancelled','refunded']);
export function customerActivityBookings<T extends ActivityBooking>(bookings:T[],segment:'upcoming'|'completed'|'subscriptions'):T[]{
 if(segment==='subscriptions')return [];
 return bookings.filter(booking=>terminal.has(booking.status)===(segment==='completed')).sort((a,b)=>segment==='completed'?b.scheduledStart.localeCompare(a.scheduledStart):a.scheduledStart.localeCompare(b.scheduledStart));
}
/** V2 manages a Training programme (session reschedule, cancellation review) on its own booking page, so the payment-return page is its route only while payment is pending. Legacy keeps its confirmation view. */
export function customerBookingManageHref(booking:ActivityBooking,scope:'legacy'|'v2'='legacy'):string|null{
 if(booking.serviceCode==='dog_training'&&booking.id)return scope==='v2'&&booking.status!=='payment_pending'?`/v2/booking?bookingId=${encodeURIComponent(booking.id)}`:`/mobile-app/booking-confirmation?bookingId=${encodeURIComponent(booking.id)}&payment=resume`;
 const route:Record<string,string>={grooming:'/grooming/manage',boarding:'/boarding/manage',pet_sitting:'/sitting/manage',dog_walking:'/walking/manage',pet_taxi:'/taxi/manage'};
 return route[booking.serviceCode]&&booking.id?`${route[booking.serviceCode]}?bookingId=${encodeURIComponent(booking.id)}`:null;
}
