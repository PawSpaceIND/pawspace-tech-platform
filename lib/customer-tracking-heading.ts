export type CustomerTrackingState='not_started'|'not_sharing'|'live'|'stale'|'unavailable'|'ended';
/** A lifecycle label is not evidence of a fresh GPS position or a moving vehicle. */
export function customerTrackingHeading(input:{serviceCode:string;status:string;state:CustomerTrackingState}){
 const taxi=input.serviceCode==='pet_taxi',noun=taxi?'driver':'walker';
 if(input.state==='ended')return 'Location sharing has ended';
 if(input.state==='stale')return 'Waiting for a fresh location update';
 if(input.state==='unavailable')return 'A fresh route ETA is unavailable';
 if(input.state==='not_sharing')return `Waiting for your ${noun}'s location`;
 if(input.state!=='live')return taxi?'Pet Taxi tracking has not started':'Walk tracking has not started';
 if(['completed','cancelled','canceled','refunded','failed','expired'].includes(input.status))return 'Location sharing has ended';
 if(['arrived_dropoff','dropoff_confirmed'].includes(input.status))return 'Your driver has reached the drop-off';
 if(input.status==='arrived')return taxi?'Your driver has arrived':'Your walker has arrived';
 if(['in_progress','in_service'].includes(input.status))return taxi?'Your Pet Taxi trip is in progress':'Your walk is in progress';
 if(input.status==='on_the_way')return taxi?'Your driver is on the way':'Your walker is on the way';
 return taxi?'Driver location available':'Walker location available';
}
