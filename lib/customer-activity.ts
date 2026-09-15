/**
 * Dog Training had NO entry in this map, so a training booking's Activity card was the only one in
 * the app with no manage link at all - while the checkout the customer had just agreed to promised
 * that "Cancellation requests go for PawSpace approval" and that sessions could be rescheduled. Both
 * endpoints existed (/api/training-cancellation, /api/training-customer-session-change) and nothing
 * in the customer UI could reach either. [R3-A2]
 */
export type ActivityBooking={id:string;serviceCode:string;scheduledStart:string;status:string};
const terminal=new Set(['completed','cancelled','refunded']);
export function customerActivityBookings<T extends ActivityBooking>(bookings:T[],segment:'upcoming'|'completed'|'subscriptions'):T[]{
 if(segment==='subscriptions')return [];
 return bookings.filter(booking=>terminal.has(booking.status)===(segment==='completed')).sort((a,b)=>segment==='completed'?b.scheduledStart.localeCompare(a.scheduledStart):a.scheduledStart.localeCompare(b.scheduledStart));
}
export function customerBookingManageHref(booking:ActivityBooking):string|null{
 const route:Record<string,string>={grooming:'/grooming/manage',boarding:'/boarding/manage',pet_sitting:'/sitting/manage',dog_walking:'/walking/manage',pet_taxi:'/taxi/manage',dog_training:'/training/manage'};
 return route[booking.serviceCode]&&booking.id?`${route[booking.serviceCode]}?bookingId=${encodeURIComponent(booking.id)}`:null;
}

/**
 * A service time as the customer must read it: Asia/Kolkata, explicitly labelled IST.
 *
 * The booking flows label every time "IST"; the manage screens formatted the same instant with a bare
 * toLocaleString(), which renders in the BROWSER's zone. A customer opening their booking from a
 * different timezone - or a support agent doing it for them - read a different clock time for the same
 * session with nothing on screen to say so.
 */
export function customerServiceTimeLabel(value:unknown,options:Intl.DateTimeFormatOptions={day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"}):string{
 const date=new Date(String(value??""));
 if(Number.isNaN(date.getTime()))return "time not set";
 return `${date.toLocaleString("en-IN",{timeZone:"Asia/Kolkata",...options})} IST`;
}
