type Db=D1Database;
type Row=Record<string,unknown>;

export type ProviderPoint={lat:number;lng:number;accuracyMeters?:number;capturedAt?:number};
export type RouteResult={status:"configured"|"configuration_required"|"route_unavailable";distanceMeters?:number;durationSeconds?:number;polyline?:string;provider?:"google_routes";error?:string};

export async function ensureGroomingMapTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS booking_service_locations (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'customer_booking',status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_location_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,accuracy_meters REAL,captured_at INTEGER NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_route_snapshots (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,origin_latitude REAL NOT NULL,origin_longitude REAL NOT NULL,destination_address TEXT NOT NULL,distance_meters INTEGER,duration_seconds INTEGER,route_status TEXT NOT NULL,provider TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}

export function mapsNavigationUrl(destinationAddress:string,origin?:ProviderPoint){const params=new URLSearchParams({api:"1",destination:destinationAddress,travelmode:"driving"});if(origin)params.set("origin",`${origin.lat},${origin.lng}`);return `https://www.google.com/maps/dir/?${params.toString()}`;}

function seconds(value:unknown){const match=String(value||"").match(/^([0-9.]+)s$/);return match?Math.round(Number(match[1])):undefined;}

/** Same ceiling the outbound media fetch uses (DEFAULT_VOICE_TIMEOUT_MS). */
export const MAPS_REQUEST_TIMEOUT_MS=10_000;

/**
 * A point this adapter is willing to send to the map provider. The GPS ingestion route validates its
 * own input, but validation that lives only in ONE caller is not a property of the adapter: any other
 * caller - and there is already a second, the location-recovery ETA action reading stored coordinates -
 * would hand NaN or an out-of-range pair straight to Google. NaN also serialises to `null` in the
 * request body, so the provider sees a malformed request rather than a refusal we made deliberately.
 */
export function validRoutePoint(point:ProviderPoint|null|undefined):boolean{
  return Boolean(point)&&Number.isFinite(point!.lat)&&point!.lat>=-90&&point!.lat<=90&&Number.isFinite(point!.lng)&&point!.lng>=-180&&point!.lng<=180;
}

export async function computeGoogleRoute(origin:ProviderPoint,destinationAddress:string):Promise<RouteResult>{
  const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;const mode=String(runtime.PAWSPACE_MAPS_ENV||"sandbox").toLowerCase();if(mode!=="sandbox")return{status:"configuration_required",error:"Maps UAT adapter is locked to sandbox"};const key=String(runtime.GOOGLE_MAPS_SERVER_API_KEY_UAT||"").trim();if(!key)return{status:"configuration_required",error:"GOOGLE_MAPS_SERVER_API_KEY_UAT is not configured"};
  // Refuse before spending a provider call, and before a malformed coordinate can reach a third party.
  if(!validRoutePoint(origin))return{status:"route_unavailable",error:"Origin coordinates are missing or out of range"};
  if(!String(destinationAddress||"").trim())return{status:"route_unavailable",error:"Destination address is required"};
  // A provider that accepts the connection and then never answers must not hold a booking request open.
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),MAPS_REQUEST_TIMEOUT_MS);
  try{const response=await fetch("https://routes.googleapis.com/directions/v2:computeRoutes",{method:"POST",signal:controller.signal,headers:{"content-type":"application/json","X-Goog-Api-Key":key,"X-Goog-FieldMask":"routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline"},body:JSON.stringify({origin:{location:{latLng:{latitude:origin.lat,longitude:origin.lng}}},destination:{address:destinationAddress},travelMode:"DRIVE",routingPreference:"TRAFFIC_AWARE",languageCode:"en-IN",units:"METRIC"})});const body=await response.json().catch(()=>({})) as {routes?:Array<{duration?:string;distanceMeters?:number;polyline?:{encodedPolyline?:string}}> ;error?:{message?:string}};if(!response.ok||!body.routes?.length)return{status:"route_unavailable",error:body.error?.message||`Routes API returned ${response.status}`};const route=body.routes[0];return{status:"configured",provider:"google_routes",distanceMeters:Number(route.distanceMeters||0),durationSeconds:seconds(route.duration),polyline:route.polyline?.encodedPolyline};}
  catch(error){const aborted=controller.signal.aborted||(error as Error)?.name==="AbortError";return{status:"route_unavailable",error:aborted?`Routes API did not respond within ${MAPS_REQUEST_TIMEOUT_MS}ms`:(error instanceof Error?error.message:"Unable to call Routes API")};}
  finally{clearTimeout(timer);}
}

export async function saveRouteSnapshot(db:Db,input:{bookingId:string;providerId:string;origin:ProviderPoint;destinationAddress:string;route:RouteResult}){await ensureGroomingMapTables(db);const now=Date.now();await db.prepare("INSERT INTO grooming_route_snapshots (id,booking_id,provider_id,origin_latitude,origin_longitude,destination_address,distance_meters,duration_seconds,route_status,provider,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(`ROUTE-${crypto.randomUUID().slice(0,12).toUpperCase()}`,input.bookingId,input.providerId,input.origin.lat,input.origin.lng,input.destinationAddress,input.route.distanceMeters??null,input.route.durationSeconds??null,input.route.status,input.route.provider||"google_routes",JSON.stringify({error:input.route.error||null,polyline:input.route.polyline||null}),now).run();}

export async function latestProviderPoint(db:Db,bookingId:string,providerId:string){await ensureGroomingMapTables(db);const row=await db.prepare("SELECT latitude,longitude,accuracy_meters,captured_at FROM provider_location_events WHERE booking_id=? AND provider_id=? ORDER BY captured_at DESC LIMIT 1").bind(bookingId,providerId).first<Row>();return row?{lat:Number(row.latitude),lng:Number(row.longitude),accuracyMeters:Number(row.accuracy_meters||0),capturedAt:Number(row.captured_at||0)}:null;}
