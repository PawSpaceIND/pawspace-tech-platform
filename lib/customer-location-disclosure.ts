export const CUSTOMER_LOCATION_DISCLOSURE_POLICY={
  serviceCode:"grooming",
  visibleBookingStatuses:["on_the_way","arrived","in_service"] as const,
  postCompletionWindowMs:0,
  exposeRawCoordinates:false,
  exposeAccuracy:false,
  exposeEvidenceIds:false,
} as const;

export type CustomerTrackingState="not_started"|"not_sharing"|"live"|"stale"|"unavailable"|"ended";

type EtaEvidence={
  providerStatus?:unknown;
  distanceMeters?:unknown;
  durationSeconds?:unknown;
  calculatedAt?:unknown;
  staleAfter?:unknown;
}|null;

export function customerTrackingProjection(input:{bookingStatus:unknown;hasTrustedLocation:boolean;eta:EtaEvidence;now?:number}){
  const status=String(input.bookingStatus||"");
  const now=input.now??Date.now();
  if(["completed","cancelled","refunded","failed"].includes(status))return{state:"ended" as const,etaMinutes:null,distanceKm:null};
  if(!(CUSTOMER_LOCATION_DISCLOSURE_POLICY.visibleBookingStatuses as readonly string[]).includes(status))return{state:"not_started" as const,etaMinutes:null,distanceKm:null};
  if(!input.hasTrustedLocation)return{state:"not_sharing" as const,etaMinutes:null,distanceKm:null};
  if(!input.eta)return{state:"unavailable" as const,etaMinutes:null,distanceKm:null};
  const staleAfter=Number(input.eta.staleAfter||0);
  if(!Number.isFinite(staleAfter)||staleAfter<=now)return{state:"stale" as const,etaMinutes:null,distanceKm:null};
  if(String(input.eta.providerStatus||"")!=="configured")return{state:"unavailable" as const,etaMinutes:null,distanceKm:null};
  const duration=Number(input.eta.durationSeconds),distance=Number(input.eta.distanceMeters);
  if(!Number.isFinite(duration)||duration<=0)return{state:"unavailable" as const,etaMinutes:null,distanceKm:null};
  return{
    state:"live" as const,
    etaMinutes:Math.max(1,Math.round(duration/60)),
    distanceKm:Number.isFinite(distance)&&distance>=0?Math.round(distance/100)/10:null,
  };
}

/** Booking statuses where the customer live-tracking card is shown. Unpaid and closed bookings never poll. */
const LIVE_CARD_HIDDEN_STATUSES=new Set(["payment_pending","completed","cancelled","canceled","refunded","failed","expired"]);
export function customerGroomingLiveCardVisible(serviceCode:unknown,bookingStatus:unknown){
  return String(serviceCode||"")==="grooming"&&!LIVE_CARD_HIDDEN_STATUSES.has(String(bookingStatus||""));
}
