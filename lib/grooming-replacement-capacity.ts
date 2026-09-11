type Row=Record<string,unknown>;
/** Re-evaluated inside the assignment transaction using the current profile and authored roster. */
export function groomingReplacementCapacity(booking:Row,providerId:string,providerModel:string){
 const start=String(booking.scheduled_start),end=String(booking.scheduled_end),group=String(booking.schedule_group_id);
 /*
  * An unreadable window is refused with a named error, not a raw RangeError. `new Date(NaN)
  * .toISOString()` throws "Invalid time value", which surfaced from inside the assignment
  * transaction on the provider-recovery path as an unexplained 500 rather than as a refusal
  * anyone could act on - and this runs when a groomer has already fallen through and a customer
  * is waiting for a replacement. lib/booking-window-instant.ts states the same rule for the same
  * reason: a window nobody can read is never evidence, in either direction. [D31-W5]
  */
 const local=(value:string)=>{
  const time=new Date(value).getTime();
  if(!Number.isFinite(time))throw new Error(`replacement_capacity_unreadable_booking_window:${value}`);
  return new Date(time+330*60000).toISOString();
 };
 const date=local(start).slice(0,10),from=local(start).slice(11,16),to=local(end).slice(11,16);
 return {sql:`EXISTS (SELECT 1 FROM provider_capacity_profiles p WHERE p.id=? AND p.provider_model=? AND p.city_id=? AND p.live=1 AND p.status='active'
 AND p.effective_from<=? AND (p.effective_to IS NULL OR p.effective_to>=?)
 AND EXISTS(SELECT 1 FROM json_each(p.services_json) WHERE value='grooming')
 AND EXISTS(SELECT 1 FROM json_each(p.zones_json) WHERE value=?)
 AND NOT EXISTS(SELECT 1 FROM provider_unavailability u WHERE u.provider_id=p.id AND u.status='active' AND u.starts_at<? AND u.ends_at>?)
 AND NOT EXISTS(SELECT 1 FROM scheduling_reservations r WHERE r.provider_id=p.id AND r.group_id!=? AND r.status!='cancelled'
 AND julianday(r.scheduled_start)<julianday(?)+COALESCE(p.travel_buffer_minutes,30)/1440.0
 AND julianday(r.scheduled_end)>julianday(?)-COALESCE(p.travel_buffer_minutes,30)/1440.0)
 AND (SELECT COUNT(*) FROM scheduling_reservations r WHERE r.provider_id=p.id AND r.group_id!=? AND r.status!='cancelled' AND date(r.scheduled_start,'+330 minutes')=?)<COALESCE(p.max_daily_jobs,6)
 AND EXISTS(SELECT 1 FROM scheduling_availability a,json_each(a.windows_json) w WHERE a.provider_id=p.id AND a.date=? AND a.zone_id=?
 AND (a.source IN ('partner_app','operations','roster') OR NOT EXISTS(SELECT 1 FROM scheduling_availability authored WHERE authored.provider_id=a.provider_id AND authored.date=a.date AND authored.source IN ('partner_app','operations','roster')))
 AND w.value GLOB '[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]' AND substr(w.value,1,5)<=? AND substr(w.value,7,5)>=?))`,values:[providerId,providerModel,booking.city_id,date,date,booking.zone_id,end,start,group,end,start,group,date,date,booking.zone_id,from,to]};
}
