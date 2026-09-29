import{governedJsonError}from"./governed-http-error";
type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const WINDOW=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

function realDate(value:string){
 if(!DATE.test(value))return false;
 const parsed=new Date(value+"T00:00:00.000Z");
 return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
function parse<T>(value:unknown,fallback:T):T{try{return JSON.parse(String(value??"")) as T;}catch{return fallback;}}
function http(message:string,status:number):never{throw governedJsonError({error:message},status);}
function normalizedWindows(value:unknown,state:"open"|"blocked"){
 if(state==="blocked")return [] as string[];
 if(!Array.isArray(value)||value.length<1||value.length>5)http("Open days require 1 to 5 availability windows",400);
 const windows=value.map(item=>text(item));
 const ranges=windows.map(window=>{
  const match=WINDOW.exec(window);if(!match)http("Availability windows must use HH:MM-HH:MM",400);
  const [a,b,c,d]=match.slice(1).map(Number),from=a*60+b,to=c*60+d;
  if(a>23||b>59||c>24||d>59||(c===24&&d!==0)||from>=to)http("Availability window is invalid or reversed",400);
  return{window,from,to};
 }).sort((x,y)=>x.from-y.from||x.to-y.to);
 for(let i=1;i<ranges.length;i++)if(ranges[i].from<ranges[i-1].to)http("Availability windows cannot overlap",400);
 return ranges.map(item=>item.window);
}

export async function ensureProviderSelfCalendarTable(db:Db){
 await db.prepare("CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)").run();
}

async function activeProfile(db:Db,providerId:string){
 const row=await db.prepare("SELECT id,city_id,provider_model,zones_json,live,status FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();
 if(!row||Number(row.live)!==1||text(row.status)!=="active")http("Active provider profile is required",409);
 return{providerId:text(row.id),cityId:text(row.city_id),providerModel:text(row.provider_model),zones:parse<string[]>(row.zones_json,[])};
}
function rangeProblem(from:string,to:string){
 if(!realDate(from)||!realDate(to)||to<from)return"Valid ordered calendar dates are required";
 const span=Math.floor((Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86400000)+1;
 if(span>62)return"Calendar range is limited to 62 days";
 return"";
}

export async function providerCalendarSnapshot(db:Db,input:{providerId:string;from:string;to:string}){
 await ensureProviderSelfCalendarTable(db);
 const problem=rangeProblem(input.from,input.to);if(problem)http(problem,400);
 const profile=await activeProfile(db,input.providerId);
 const rows=await db.prepare("SELECT id,date,zone_id,windows_json,source,updated_at FROM scheduling_availability WHERE provider_id=? AND date>=? AND date<=? AND source IN ('partner_app','operations','roster') ORDER BY date,zone_id,CASE source WHEN 'operations' THEN 0 WHEN 'roster' THEN 1 ELSE 2 END,id")
  .bind(input.providerId,input.from,input.to).all<Row>();
 return{...profile,editable:profile.providerModel==="commission",days:rows.results.map(row=>({
  id:text(row.id),date:text(row.date),zoneId:text(row.zone_id),windows:parse<string[]>(row.windows_json,[]),
  state:parse<string[]>(row.windows_json,[]).length?"open":"blocked",source:text(row.source),
  locked:text(row.source)!=="partner_app",updatedAt:Number(row.updated_at||0),
 }))};
}

export async function saveProviderCalendarDay(db:Db,input:{providerId:string;date:string;zoneId:string;state:"open"|"blocked";windows?:unknown}){
 await ensureProviderSelfCalendarTable(db);
 if(!realDate(input.date))http("A valid calendar date is required",400);
 const profile=await activeProfile(db,input.providerId);
 if(profile.providerModel!=="commission")http("Dated Open / Blocked self-service is only for commission providers",409);
 if(!profile.zones.includes(input.zoneId))http("Choose one of this provider's service zones",400);
 const windows=normalizedWindows(input.windows,input.state);
 const locked=await db.prepare("SELECT id,source FROM scheduling_availability WHERE provider_id=? AND date=? AND zone_id=? AND source IN ('operations','roster') LIMIT 1")
  .bind(input.providerId,input.date,input.zoneId).first<Row>();
 if(locked)http("This date and zone are managed by Operations and cannot be widened in self-service",409);
 const id=`availability_${input.providerId}_${input.date}_${input.zoneId}`,now=Date.now();
 await db.batch([
  db.prepare("DELETE FROM scheduling_availability WHERE provider_id=? AND date=? AND zone_id=? AND source='partner_app'").bind(input.providerId,input.date,input.zoneId),
  db.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,'partner_app',?)")
   .bind(id,input.providerId,profile.cityId,input.zoneId,input.date,JSON.stringify(windows),now),
 ]);
 return{id,providerId:input.providerId,cityId:profile.cityId,zoneId:input.zoneId,date:input.date,state:windows.length?"open":"blocked",windows,source:"partner_app",locked:false,updatedAt:now};
}
