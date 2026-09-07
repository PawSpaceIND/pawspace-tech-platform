import{ensureUniversalLocationTables,startLocationSession}from"./universal-location-recovery";
import{classifyGpsObservation,gpsIngestionKey,haversineDistanceMeters,type GpsTrustVerdict}from"./gps-telemetry-policy";
import{securityAuditStatement,type AuthenticatedActor}from"./server-auth";
import type{RouteResult}from"./grooming-maps";

type Db=D1Database;
type Row=Record<string,unknown>;
const eventId=()=>`LOC-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const etaId=()=>`ETA-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export type GroomingTelemetryInput={bookingId:string;providerId:string;latitude:number;longitude:number;accuracyMeters:number;capturedAt:number;idempotencyKey?:string};
export type PreparedGroomingTelemetry={sessionId:string;policyId:string;serverReceivedAt:number;capturedAt:number;accuracyMeters:number;verdict:GpsTrustVerdict;idempotencyKey:string};

export async function ensureGroomingGpsPipelineTables(db:Db){
 await ensureUniversalLocationTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_location_ingestions (idempotency_key TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,event_id TEXT NOT NULL,eta_snapshot_id TEXT,trust_state TEXT NOT NULL,route_status TEXT,distance_from_previous_meters INTEGER,cumulative_distance_meters INTEGER NOT NULL DEFAULT 0,response_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS grooming_location_ingestions_booking_idx ON grooming_location_ingestions(booking_id,provider_id,created_at)"),
  db.prepare("CREATE INDEX IF NOT EXISTS universal_provider_location_events_booking_received_idx ON universal_provider_location_events(booking_id,provider_id,server_received_at DESC)"),
  db.prepare("CREATE INDEX IF NOT EXISTS route_eta_snapshots_booking_calc_idx ON route_eta_snapshots(booking_id,provider_id,calculated_at DESC)"),
 ]);
}

export async function existingGroomingTelemetry(db:Db,idempotencyKey:string){await ensureGroomingGpsPipelineTables(db);const row=await db.prepare("SELECT response_json FROM grooming_location_ingestions WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();return row?JSON.parse(String(row.response_json||"{}")) as Record<string,unknown>:null;}

export async function prepareGroomingTelemetry(db:Db,input:GroomingTelemetryInput,actor:string):Promise<PreparedGroomingTelemetry>{
 await ensureGroomingGpsPipelineTables(db);const session=await startLocationSession(db,{bookingId:input.bookingId,providerId:input.providerId,actor}),sessionId=String((session as Row).id||"");
 const row=await db.prepare("SELECT s.policy_version_id,p.eta_freshness_seconds,p.allowed_accuracy_meters,c.gps_ingestion_enabled FROM provider_location_sessions s JOIN booking_punctuality_policies p ON p.id=s.policy_version_id CROSS JOIN location_control_settings c WHERE s.id=? AND s.status='active' AND c.id='global'").bind(sessionId).first<Row>();if(!row)throw new Error("active_location_policy_not_found");
 const received=Date.now(),captured=Number(input.capturedAt),accuracy=Number(input.accuracyMeters),verdict=classifyGpsObservation({latitude:Number(input.latitude),longitude:Number(input.longitude),accuracyMeters:accuracy,clientCapturedAt:captured,serverReceivedAt:received,freshnessSeconds:Number(row.eta_freshness_seconds||0),allowedAccuracyMeters:Number(row.allowed_accuracy_meters||0),gpsIngestionEnabled:Number(row.gps_ingestion_enabled)===1});
 return{sessionId,policyId:String(row.policy_version_id),serverReceivedAt:received,capturedAt:captured,accuracyMeters:accuracy,verdict,idempotencyKey:String(input.idempotencyKey||gpsIngestionKey(input))};
}

async function pathMetrics(db:Db,input:GroomingTelemetryInput){
 const previous=await db.prepare("SELECT latitude,longitude FROM universal_provider_location_events WHERE booking_id=? AND provider_id=? AND trust_state='accepted' ORDER BY server_received_at DESC LIMIT 1").bind(input.bookingId,input.providerId).first<Row>(),prior=await db.prepare("SELECT cumulative_distance_meters FROM grooming_location_ingestions WHERE booking_id=? AND provider_id=? AND trust_state='accepted' ORDER BY created_at DESC LIMIT 1").bind(input.bookingId,input.providerId).first<Row>();
 const delta=previous?Math.round(haversineDistanceMeters({latitude:Number(previous.latitude),longitude:Number(previous.longitude)},{latitude:Number(input.latitude),longitude:Number(input.longitude)})):0,safeDelta=Number.isFinite(delta)&&delta>=0?delta:0,cumulative=Math.max(0,Number(prior?.cumulative_distance_meters||0))+safeDelta;
 return{distanceFromPreviousMeters:safeDelta,cumulativeDistanceMeters:Math.round(cumulative)};
}

export async function commitGroomingTelemetry(db:Db,input:{telemetry:GroomingTelemetryInput;prepared:PreparedGroomingTelemetry;destinationAddress:string;route:RouteResult|null;actor:AuthenticatedActor;travelState:string}){
 await ensureGroomingGpsPipelineTables(db);const prior=await existingGroomingTelemetry(db,input.prepared.idempotencyKey);if(prior)return{...prior,duplicate:true};
 const event=eventId(),accepted=input.prepared.verdict.trustState==="accepted",route=input.route,metrics=accepted?await pathMetrics(db,input.telemetry):{distanceFromPreviousMeters:0,cumulativeDistanceMeters:0};
 const etaSnapshotId=accepted&&route?etaId():null,calculatedAt=Date.now(),freshness=await db.prepare("SELECT eta_freshness_seconds FROM booking_punctuality_policies WHERE id=?").bind(input.prepared.policyId).first<Row>(),freshMs=Math.max(1,Number(freshness?.eta_freshness_seconds||300))*1000,routeStatus=route?.status??null,predictedArrivalAt=route?.status==="configured"&&Number.isFinite(Number(route.durationSeconds))?calculatedAt+Number(route.durationSeconds)*1000:null;
 const response={bookingId:input.telemetry.bookingId,providerId:input.telemetry.providerId,providerLocation:{lat:input.telemetry.latitude,lng:input.telemetry.longitude,accuracyMeters:input.prepared.accuracyMeters,capturedAt:input.prepared.capturedAt,serverReceivedAt:input.prepared.serverReceivedAt,trustState:input.prepared.verdict.trustState,eventId:event},travelState:input.travelState,route:accepted?route:null,path:metrics,telemetryAccepted:accepted,rejectionReason:input.prepared.verdict.reason};
 const statements=[
  db.prepare("INSERT INTO universal_provider_location_events (id,session_id,booking_id,provider_id,latitude,longitude,accuracy_meters,device_source,client_captured_at,server_received_at,trust_state,rejection_reason,created_at) VALUES (?,?,?,?,?,?,?,'provider_device',?,?,?,?,?)").bind(event,input.prepared.sessionId,input.telemetry.bookingId,input.telemetry.providerId,input.telemetry.latitude,input.telemetry.longitude,Number.isFinite(input.prepared.accuracyMeters)?input.prepared.accuracyMeters:null,input.prepared.capturedAt,input.prepared.serverReceivedAt,input.prepared.verdict.trustState,input.prepared.verdict.reason,input.prepared.serverReceivedAt),
  db.prepare("INSERT INTO grooming_location_ingestions (idempotency_key,booking_id,provider_id,event_id,eta_snapshot_id,trust_state,route_status,distance_from_previous_meters,cumulative_distance_meters,response_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(input.prepared.idempotencyKey,input.telemetry.bookingId,input.telemetry.providerId,event,etaSnapshotId,input.prepared.verdict.trustState,routeStatus,metrics.distanceFromPreviousMeters,metrics.cumulativeDistanceMeters,JSON.stringify(response),input.prepared.serverReceivedAt),
  securityAuditStatement(db,input.actor,"grooming.provider_location.update","booking",input.telemetry.bookingId,accepted?"completed":"rejected",{eventId:event,sessionId:input.prepared.sessionId,trustState:input.prepared.verdict.trustState,rejectionReason:input.prepared.verdict.reason,accuracyMeters:input.prepared.accuracyMeters,routeStatus,travelState:input.travelState,idempotencyKey:input.prepared.idempotencyKey,...metrics}),
 ];
 if(etaSnapshotId&&route)statements.splice(1,0,db.prepare("INSERT INTO route_eta_snapshots (id,booking_id,provider_id,origin_location_event_id,destination_snapshot_json,map_provider,provider_status,distance_meters,duration_seconds,predicted_arrival_at,routing_mode,calculated_at,stale_after,provider_reference,detail_json) VALUES (?,?,?,?,?,'google_routes',?,?,?,?,'traffic_aware',?,?,?,?)").bind(etaSnapshotId,input.telemetry.bookingId,input.telemetry.providerId,event,JSON.stringify({address:input.destinationAddress}),route.status,route.distanceMeters??null,route.durationSeconds??null,predictedArrivalAt,calculatedAt,calculatedAt+freshMs,null,JSON.stringify({error:route.error??null,polyline:route.polyline??null,forecast:true,guaranteedArrival:false,...metrics})));
 await db.batch(statements);return response;
}

export async function latestTrustedGroomingObservation(db:Db,bookingId:string,providerId:string){
 await ensureGroomingGpsPipelineTables(db);const control=await db.prepare("SELECT gps_ingestion_enabled FROM location_control_settings WHERE id='global'").first<Row>();if(Number(control?.gps_ingestion_enabled)!==1)return{ok:false as const,reason:"gps_kill_switch_active"};
 const row=await db.prepare("SELECT e.*,p.eta_freshness_seconds,p.allowed_accuracy_meters FROM universal_provider_location_events e JOIN provider_location_sessions s ON s.id=e.session_id JOIN booking_punctuality_policies p ON p.id=s.policy_version_id WHERE e.booking_id=? AND e.provider_id=? AND s.status='active' AND e.trust_state='accepted' ORDER BY e.server_received_at DESC LIMIT 1").bind(bookingId,providerId).first<Row>();if(!row)return{ok:false as const,reason:"trusted_location_evidence_not_found"};
 const ageMs=Date.now()-Number(row.server_received_at),freshMs=Math.max(1,Number(row.eta_freshness_seconds||0))*1000,accuracy=Number(row.accuracy_meters),allowed=Number(row.allowed_accuracy_meters||0);if(ageMs<0||ageMs>freshMs)return{ok:false as const,reason:"trusted_location_evidence_stale"};if(!Number.isFinite(accuracy)||accuracy<0||!allowed||accuracy>allowed)return{ok:false as const,reason:"trusted_location_accuracy_outside_policy"};
 return{ok:true as const,evidence:{id:String(row.id),sessionId:String(row.session_id),latitude:Number(row.latitude),longitude:Number(row.longitude),accuracyMeters:accuracy,clientCapturedAt:Number(row.client_captured_at),serverReceivedAt:Number(row.server_received_at),ageMs,allowedAccuracyMeters:allowed}};
}
