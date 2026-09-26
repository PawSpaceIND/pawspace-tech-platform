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

/** Owner decision (QA M2): fixes 5 km apart 70 s apart (~260 km/h) were both trusted, so a spoofed location
 * could pass the arrival geofence. A fix implying more than 120 km/h since the last trusted fix is rejected.
 * Each fix's reported accuracy is subtracted first and jumps under 500 m are ignored, so GPS noise is not flagged.
 * Elapsed time is the device gap, capped at the server gap + 30 s when both server times are known: a phone may
 * backdate a capture by up to the freshness window, and that must not let a 10 km jump through in 1 real second. */
export const MAX_PLAUSIBLE_SPEED_KMH=120,GPS_JUMP_IGNORE_METERS=500,GPS_SERVER_GAP_ALLOWANCE_MS=30_000;
export type GpsFix={latitude:number;longitude:number;capturedAt:number;serverReceivedAt?:number|null;accuracyMeters?:number|null};
const instant=(value:unknown)=>value==null?Number.NaN:Number(value);
export function gpsElapsedMs(previous:GpsFix,next:GpsFix){const gaps=[instant(next.capturedAt)-instant(previous.capturedAt),instant(next.serverReceivedAt)-instant(previous.serverReceivedAt)+GPS_SERVER_GAP_ALLOWANCE_MS].filter(Number.isFinite);return gaps.length?Math.min(...gaps):0;}
export function implausibleGpsJump(previous:GpsFix,next:GpsFix){
 const distance=haversineDistanceMeters(previous,next);if(!Number.isFinite(distance))return false;
 const slack=Math.max(0,Number(previous.accuracyMeters)||0)+Math.max(0,Number(next.accuracyMeters)||0),moved=Math.max(0,distance-slack);
 if(moved<GPS_JUMP_IGNORE_METERS)return false;
 const seconds=Math.max(1,gpsElapsedMs(previous,next)/1000);
 return moved/seconds*3.6>MAX_PLAUSIBLE_SPEED_KMH;
}

/** Owner decision (26 Sept 2026): one bad fix must never block a groomer's arrival. The speed check compares only
 * against the newest accepted fix received within the freshness window (nothing there, no check - so the first fix
 * of a job is never rejected). If that fix is ISOLATED (no other accepted fix in the window within 500 m of it) and
 * at least 3 consecutive fixes including the new one were refused for speed, agree with each other and span at least
 * 30 s of server time, the new fix is accepted as the new baseline and the caller audits gps_baseline_reset.
 * A comparison point corroborated by other accepted fixes is never reset. */
export const GPS_BASELINE_RESET_MIN_FIXES=3,GPS_BASELINE_RESET_MIN_SPAN_MS=30_000;
export type GpsHistoryFix=GpsFix&{id:string;serverReceivedAt:number;trustState?:string;reason?:string|null};
export type GpsSpeedDecision={outcome:"no_comparison"}|{outcome:"plausible"|"implausible";comparison:GpsHistoryFix}|{outcome:"baseline_reset";comparison:GpsHistoryFix;corroborating:GpsHistoryFix[];spanMs:number;setAsideDistanceMeters:number};
export function gpsSpeedDecision(candidate:GpsFix&{serverReceivedAt:number},acceptedInWindow:GpsHistoryFix[],recentFixes:GpsHistoryFix[]):GpsSpeedDecision{
 const newestFirst=(a:GpsHistoryFix,b:GpsHistoryFix)=>b.serverReceivedAt-a.serverReceivedAt,accepted=[...acceptedInWindow].sort(newestFirst),comparison=accepted[0];
 if(!comparison)return{outcome:"no_comparison"};
 if(!implausibleGpsJump(comparison,candidate))return{outcome:"plausible",comparison};
 if(accepted.slice(1).some(fix=>haversineDistanceMeters(fix,comparison)<=GPS_JUMP_IGNORE_METERS))return{outcome:"implausible",comparison};
 const corroborating:GpsHistoryFix[]=[];let newer:GpsFix=candidate;
 for(const fix of[...recentFixes].sort(newestFirst)){
  if(!(fix.serverReceivedAt>comparison.serverReceivedAt)||fix.trustState!=="rejected"||fix.reason!=="implausible_speed"||implausibleGpsJump(fix,newer))break;
  corroborating.push(fix);newer=fix;const spanMs=candidate.serverReceivedAt-fix.serverReceivedAt;
  if(corroborating.length+1>=GPS_BASELINE_RESET_MIN_FIXES&&spanMs>=GPS_BASELINE_RESET_MIN_SPAN_MS)return{outcome:"baseline_reset",comparison,corroborating,spanMs,setAsideDistanceMeters:Math.round(haversineDistanceMeters(comparison,candidate))};
 }
 return{outcome:"implausible",comparison};
}
/** What the partner reads when a fix is refused for speed. Shared by the route card and the on-duty tracker. */
export const IMPLAUSIBLE_SPEED_NOTE="That fix is too far from your last accepted location to have been reached in the time between them, so it was not used. If you really are here, keep GPS on: steady readings from this spot replace it, usually within 30 seconds.";

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
