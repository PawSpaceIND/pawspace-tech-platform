export const FOREGROUND_GPS_INTERVAL_MS=8_000;
export const ARRIVAL_GEOFENCE_METERS=250;
export const MAX_FUTURE_CLOCK_SKEW_MS=5_000;

export type GpsTrustState="accepted"|"stale"|"low_accuracy"|"rejected";
export type GpsObservation={
 latitude:number;
 longitude:number;
 accuracyMeters:number;
 clientCapturedAt:number;
 serverReceivedAt:number;
 freshnessSeconds:number;
 allowedAccuracyMeters:number;
 gpsIngestionEnabled:boolean;
};
export type GpsTrustVerdict={trustState:GpsTrustState;reason:string|null;ageMs:number;clockSkewMs:number};

export function validGpsCoordinates(latitude:number,longitude:number){
 return Number.isFinite(latitude)&&latitude>=-90&&latitude<=90&&Number.isFinite(longitude)&&longitude>=-180&&longitude<=180;
}

export function classifyGpsObservation(input:GpsObservation):GpsTrustVerdict{
 if(!input.gpsIngestionEnabled)return{trustState:"rejected",reason:"gps_kill_switch_active",ageMs:0,clockSkewMs:0};
 if(!validGpsCoordinates(input.latitude,input.longitude))return{trustState:"rejected",reason:"invalid_coordinates",ageMs:0,clockSkewMs:0};
 if(!Number.isFinite(input.serverReceivedAt)||!Number.isFinite(input.clientCapturedAt)||input.clientCapturedAt<=0)return{trustState:"rejected",reason:"invalid_capture_timestamp",ageMs:0,clockSkewMs:0};
 const freshnessMs=Number(input.freshnessSeconds)*1_000;
 if(!Number.isFinite(freshnessMs)||freshnessMs<=0)return{trustState:"rejected",reason:"freshness_policy_not_configured",ageMs:0,clockSkewMs:0};
 const clockSkewMs=input.serverReceivedAt-input.clientCapturedAt,ageMs=Math.abs(clockSkewMs);
 if(clockSkewMs< -MAX_FUTURE_CLOCK_SKEW_MS)return{trustState:"stale",reason:"client_capture_ahead_of_server_time",ageMs,clockSkewMs};
 if(clockSkewMs>freshnessMs)return{trustState:"stale",reason:"client_capture_outside_freshness_window",ageMs,clockSkewMs};
 const allowed=Number(input.allowedAccuracyMeters),accuracy=Number(input.accuracyMeters);
 if(!Number.isFinite(allowed)||allowed<=0)return{trustState:"rejected",reason:"accuracy_policy_not_configured",ageMs,clockSkewMs};
 if(!Number.isFinite(accuracy)||accuracy<0)return{trustState:"low_accuracy",reason:Number.isFinite(accuracy)?"accuracy_reported_as_negative":"accuracy_not_reported_by_device",ageMs,clockSkewMs};
 if(accuracy>allowed)return{trustState:"low_accuracy",reason:"accuracy_outside_approved_policy",ageMs,clockSkewMs};
 return{trustState:"accepted",reason:null,ageMs,clockSkewMs};
}

const radians=(degrees:number)=>degrees*Math.PI/180;
export function haversineDistanceMeters(from:{latitude:number;longitude:number},to:{latitude:number;longitude:number}){
 if(!validGpsCoordinates(from.latitude,from.longitude)||!validGpsCoordinates(to.latitude,to.longitude))return Number.POSITIVE_INFINITY;
 const radiusMeters=6_371_000,dLat=radians(to.latitude-from.latitude),dLng=radians(to.longitude-from.longitude),lat1=radians(from.latitude),lat2=radians(to.latitude);
 const a=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
 return radiusMeters*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

export function arrivalGeofenceVerdict(from:{latitude:number;longitude:number},to:{latitude:number;longitude:number},thresholdMeters=ARRIVAL_GEOFENCE_METERS){
 const distanceMeters=Math.round(haversineDistanceMeters(from,to));
 return{within:Number.isFinite(distanceMeters)&&distanceMeters<=thresholdMeters,distanceMeters,thresholdMeters};
}

export function gpsIngestionKey(input:{bookingId:string;providerId:string;capturedAt:number;latitude:number;longitude:number}){
 const lat=Number(input.latitude).toFixed(6),lng=Number(input.longitude).toFixed(6),captured=Math.trunc(Number(input.capturedAt));
 return`gps:${input.bookingId}:${input.providerId}:${captured}:${lat}:${lng}`;
}

export function shouldApplyTelemetryResponse(sequence:number,lastAppliedSequence:number){
 return Number.isInteger(sequence)&&sequence>lastAppliedSequence;
}
