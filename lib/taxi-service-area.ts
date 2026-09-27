import{seedDefaultCityLaunchConfigs}from"./city-governance";
import{haversineDistanceMeters}from"./gps-telemetry-policy";
type Row=Record<string,unknown>;
export type TaxiAreaPoint={latitude:number;longitude:number};
export type TaxiServiceArea={cityCode:string;city:string;centre:TaxiAreaPoint;radiusKm:number};
/**
 * Where a PawSpace Pet Taxi may pick up: inside a serving city's geofence (the centre and radius the
 * founder keeps in the City & Geofence console, city_launch_configs - Bengaluru is seeded at 12.9716,
 * 77.5946 with 35 km), judged on the pickup's server-geocoded coordinates.
 *
 * The typed PIN is not evidence of where the pickup is. Round 2 quoted "Mysore Palace, Mysuru" (geocoded
 * 147 km away), typed Bengaluru PIN 560038, and the ride was assigned, bookable and payable, because the
 * only area check was the PIN's zone. The drop-off is not limited here: long rides out of the city are a
 * priced product (the XUV has no distance ceiling), a pickup outside it is not.
 */
const NOT_SERVING=new Set(["Paused","Closed"]);
export function parseGeofenceCentre(value:unknown):TaxiAreaPoint|null{
 const parts=String(value??"").split(",").map(part=>part.trim());
 if(parts.length!==2||parts.some(part=>!part))return null;
 const[latitude,longitude]=parts.map(Number);
 return Number.isFinite(latitude)&&Number.isFinite(longitude)&&latitude>=-90&&latitude<=90&&longitude>=-180&&longitude<=180?{latitude,longitude}:null;
}
export async function taxiServiceAreas(db:D1Database):Promise<TaxiServiceArea[]>{
 await seedDefaultCityLaunchConfigs(db);
 const rows=await db.prepare("SELECT city_code,city,status,centre,radius_km FROM city_launch_configs").all<Row>();
 return rows.results.flatMap(row=>{const centre=parseGeofenceCentre(row.centre),radiusKm=Number(row.radius_km);return!NOT_SERVING.has(String(row.status))&&centre&&Number.isFinite(radiusKm)&&radiusKm>0?[{cityCode:String(row.city_code||"").trim().toLowerCase(),city:String(row.city||"").trim(),centre,radiusKm}]:[];});
}
export function taxiServiceAreaFor(areas:readonly TaxiServiceArea[],point:TaxiAreaPoint,cityId?:string){
 const city=String(cityId||"").trim().toLowerCase();
 return areas.find(area=>(!city||area.cityCode===city)&&haversineDistanceMeters(area.centre,point)<=area.radiusKm*1000)??null;
}
const km=(value:number)=>Number.isInteger(value)?String(value):value.toFixed(1);
/**
 * Refuses (409, a plain sentence) a pickup outside the service area. With a cityId (the booking's city)
 * the pickup must lie inside THAT city's geofence; a city that publishes no geofence has no coordinate
 * rule, so its PIN coverage stays the only one. Without a cityId (the fare quote) it must lie inside any
 * serving city's geofence.
 */
export async function assertTaxiPickupInServiceArea(db:D1Database,input:{pickup:TaxiAreaPoint;cityId?:string}){
 const areas=await taxiServiceAreas(db),city=String(input.cityId||"").trim().toLowerCase();
 const governing=city?areas.filter(area=>area.cityCode===city):areas;
 if(!governing.length)return null;
 const area=taxiServiceAreaFor(governing,input.pickup);if(area)return area;
 const named=governing.length===1?governing[0]:null;
 throw new Response(named?`PawSpace Pet Taxi picks up only within ${named.city} (up to ${km(named.radiusKm)} km from the city centre). This pickup address is outside that area - choose a pickup inside ${named.city}.`:"This pickup address is outside the PawSpace Pet Taxi service area. Choose a pickup inside a city PawSpace serves.",{status:409});
}
