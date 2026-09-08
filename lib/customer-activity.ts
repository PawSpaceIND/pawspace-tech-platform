export type ActivityBooking={id:string;serviceCode:string;scheduledStart:string;status:string};
const terminal=new Set(['completed','cancelled','refunded']);
export function customerActivityBookings<T extends ActivityBooking>(bookings:T[],segment:'upcoming'|'completed'|'subscriptions'):T[]{
 if(segment==='subscriptions')return [];
 return bookings.filter(booking=>terminal.has(booking.status)===(segment==='completed')).sort((a,b)=>segment==='completed'?b.scheduledStart.localeCompare(a.scheduledStart):a.scheduledStart.localeCompare(b.scheduledStart));
}
export function customerBookingManageHref(booking:ActivityBooking):string|null{
 const route:Record<string,string>={pet_sitting:'/sitting/manage',dog_walking:'/walking/manage',pet_taxi:'/taxi/manage'};
 return route[booking.serviceCode]&&booking.id?`${route[booking.serviceCode]}?bookingId=${encodeURIComponent(booking.id)}`:null;
}
