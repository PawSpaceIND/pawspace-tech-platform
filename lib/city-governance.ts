type Db=D1Database;
type Row=Record<string,unknown>;
import{BENGALURU_SUPPORTED_PINCODES}from"./service-zones";

/** `Live` is this platform's word for the approved matrix's ACTIVE; `Closed` completes it. [PTJA-W1-F38] */
export type CityLaunchStatus="Draft"|"Pilot"|"Live"|"Paused"|"Closed";
export type CityLaunchService="Grooming"|"Training"|"Boarding"|"Pet Sitting";
export type CityServicePrice={enabled:boolean;price:number};
export type CityLaunchConfig={
  id:string;cityCode:string;city:string;state:string;status:CityLaunchStatus;centre:string;radiusKm:number;pincodes:string;gstIncluded:boolean;
  services:Record<CityLaunchService,CityServicePrice>;version:number;updatedBy:string;createdAt:number;updatedAt:number;
};
export type CityLaunchConfigInput={id?:string;cityCode:string;city:string;state:string;status:CityLaunchStatus;centre:string;radiusKm:number;pincodes:string;gstIncluded:boolean;services:Record<CityLaunchService,CityServicePrice>;
  /**
   * The version the operator LOADED. Required when updating an existing city, absent when creating one.
   * This is the API contract half of PTJA-P1-F40 - without it the server cannot tell a fresh edit from
   * a stale one, and "the caller did not say" must never mean "overwrite whatever is there".
   */
  baseVersion?:number};

const serviceNames:CityLaunchService[]=["Grooming","Training","Boarding","Pet Sitting"];
const parse=<T,>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??""))as T;}catch{return fallback;}};

const cityLaunchTablesReady=new WeakSet<Db>();
const cityLaunchSeedReady=new WeakSet<Db>();
export async function ensureCityLaunchTables(db:Db){
  if(cityLaunchTablesReady.has(db))return;
  const rows=await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('city_launch_configs','idx_city_launch_status','city_launch_config_audit')").all<Row>().catch(()=>({results:[] as Row[]}));
  if(new Set(rows.results.map(row=>String(row.name))).size!==3)await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS city_launch_configs (id TEXT PRIMARY KEY,city_code TEXT NOT NULL UNIQUE,city TEXT NOT NULL,state TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Draft',centre TEXT NOT NULL DEFAULT '',radius_km REAL NOT NULL DEFAULT 15,pincodes TEXT NOT NULL DEFAULT '',gst_included INTEGER NOT NULL DEFAULT 1,services_json TEXT NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_city_launch_status ON city_launch_configs(status)"),
    db.prepare("CREATE TABLE IF NOT EXISTS city_launch_config_audit (id TEXT PRIMARY KEY,city_config_id TEXT NOT NULL,city TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  ]);
  cityLaunchTablesReady.add(db);
}

export async function seedDefaultCityLaunchConfigs(db:Db){
  if(cityLaunchSeedReady.has(db))return;await ensureCityLaunchTables(db);
  const existing=await db.prepare("SELECT id,pincodes,updated_by FROM city_launch_configs WHERE id='bengaluru'").first<Row>();
  const exactPincodes=BENGALURU_SUPPORTED_PINCODES.join(",");
  if(!existing){const now=Date.now();const services:Record<CityLaunchService,CityServicePrice>={Grooming:{enabled:true,price:1349},Training:{enabled:true,price:3500},Boarding:{enabled:true,price:899},"Pet Sitting":{enabled:true,price:699}};await db.prepare("INSERT OR IGNORE INTO city_launch_configs (id,city_code,city,state,status,centre,radius_km,pincodes,gst_included,services_json,version,updated_by,created_at,updated_at) VALUES ('bengaluru','blr','Bengaluru','Karnataka','Live','12.9716, 77.5946',35,?,1,?,1,'founder_seed',?,?)").bind(exactPincodes,JSON.stringify(services),now,now).run();}
  else if(String(existing.updated_by)==='founder_seed'&&String(existing.pincodes).replace('–','-')==='560001-560110'){const now=Date.now();await db.prepare("UPDATE city_launch_configs SET pincodes=?,version=version+1,updated_at=? WHERE id='bengaluru' AND updated_by='founder_seed' AND REPLACE(pincodes,'–','-')='560001-560110'").bind(exactPincodes,now).run();}
  cityLaunchSeedReady.add(db);
}

function rowToConfig(row:Row):CityLaunchConfig{return{
  id:String(row.id),cityCode:String(row.city_code||""),city:String(row.city),state:String(row.state),status:["Draft","Pilot","Live","Paused","Closed"].includes(String(row.status))?String(row.status)as CityLaunchStatus:"Draft",
  centre:String(row.centre||""),radiusKm:Number(row.radius_km||15),pincodes:String(row.pincodes||""),gstIncluded:Boolean(row.gst_included),
  services:parse<Record<CityLaunchService,CityServicePrice>>(row.services_json,{Grooming:{enabled:false,price:0},Training:{enabled:false,price:0},Boarding:{enabled:false,price:0},"Pet Sitting":{enabled:false,price:0}}),
  version:Number(row.version||1),updatedBy:String(row.updated_by||""),createdAt:Number(row.created_at||0),updatedAt:Number(row.updated_at||0),
};}

export async function listCityLaunchConfigs(db:Db):Promise<CityLaunchConfig[]>{await seedDefaultCityLaunchConfigs(db);const rows=await db.prepare("SELECT * FROM city_launch_configs ORDER BY created_at ASC").all<Row>();return rows.results.map(rowToConfig);}

const serviceAlias:Record<string,CityLaunchService>={grooming:"Grooming",training:"Training",boarding:"Boarding",sitting:"Pet Sitting",pet_sitting:"Pet Sitting","pet sitting":"Pet Sitting"};
export async function resolveCityServiceCoverage(db:Db,input:{cityCode:string;serviceCode:string;pincode?:string}){
  await seedDefaultCityLaunchConfigs(db);
  const cityCode=input.cityCode.trim().toLowerCase(),service=serviceAlias[input.serviceCode.trim().toLowerCase()];
  if(!service)return{supported:false,reason:"unsupported_service",cityCode,serviceCode:input.serviceCode};
  const row=await db.prepare("SELECT * FROM city_launch_configs WHERE city_code=? AND status='Live'").bind(cityCode).first<Row>();
  if(!row)return{supported:false,reason:"city_not_live",cityCode,serviceCode:input.serviceCode};
  const config=rowToConfig(row);
  if(!config.services[service]?.enabled)return{supported:false,reason:"service_not_live",cityCode,serviceCode:input.serviceCode};
  const pincode=String(input.pincode||"").replace(/\D/g,"").slice(0,6);
  if(pincode){
    const advertised=new Set(config.pincodes.split(",").map(value=>value.replace(/\D/g,"").slice(0,6)).filter(value=>value.length===6));
    if(!advertised.has(pincode))return{supported:false,reason:"pincode_not_supported",cityCode,serviceCode:input.serviceCode,pincode};
  }
  return{supported:true,reason:"live_and_explicitly_supported",cityCode,city:config.city,serviceCode:input.serviceCode,pincode:pincode||null,startingPrice:config.services[service].price};
}

function validate(input:CityLaunchConfigInput):string|null{
  const code=input.cityCode.trim().toLowerCase();
  if(!code)return "City code is required (short lowercase code used across pricing, tax and coupons, e.g. 'blr')";
  if(!/^[a-z][a-z0-9]{1,7}$/.test(code))return "City code must be 2-8 lowercase letters/numbers, starting with a letter (e.g. 'blr', 'chn')";
  if(!input.city.trim())return "City name is required";
  if(!input.state.trim())return "State is required";
  if(!["Draft","Pilot","Live","Paused","Closed"].includes(input.status))return "Invalid launch status";
  if(!input.centre.trim()&&!input.pincodes.trim())return "Add centre coordinates or serviceable pincodes";
  if(!Number.isFinite(input.radiusKm)||input.radiusKm<1)return "Service radius must be at least 1 km";
  if(input.centre.trim()){
    const parts=input.centre.split(",").map(part=>Number(part.trim()));
    if(parts.length!==2||parts.some(part=>!Number.isFinite(part)))return "Geofence centre must be latitude, longitude";
    const[lat,lng]=parts;if(lat<-90||lat>90||lng<-180||lng>180)return "Geofence centre coordinates are out of range";
  }
  for(const name of serviceNames){
    const service=input.services[name];
    if(!service)return `Missing service configuration for ${name}`;
    if(service.enabled&&(!Number.isFinite(service.price)||service.price<0))return `${name} needs a valid starting price when enabled`;
  }
  if(input.status==="Live"&&!serviceNames.some(name=>input.services[name]?.enabled))return "At least one service must be enabled before a city can go Live";
  return null;
}

/**
 * A refused save is a thing that happened. Recording only accepted writes leaves the audit trail
 * saying two operators agreed when one of them was overruled. [PTJA-W3-CC]
 */
async function recordCoverageConflict(db:Db,id:string,input:CityLaunchConfigInput,actorId:string,declared:number,current:CityLaunchConfig|null,now:number){
  await db.prepare("INSERT INTO city_launch_config_audit (id,city_config_id,city,action,before_json,after_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),id,input.city.trim(),"update_rejected_version_conflict",
      current?JSON.stringify(current):null,
      JSON.stringify({attempted:{pincodes:input.pincodes,status:input.status,radiusKm:input.radiusKm},baseVersion:declared,latestVersion:current?.version??null}),
      actorId,now).run();
}

export async function saveCityLaunchConfig(db:Db,input:CityLaunchConfigInput,actorId:string):Promise<CityLaunchConfig>{
  await seedDefaultCityLaunchConfigs(db);
  const problem=validate(input);if(problem)throw new Error(problem);
  const code=input.cityCode.trim().toLowerCase();
  const now=Date.now();
  const existing=input.id?await db.prepare("SELECT * FROM city_launch_configs WHERE id=?").bind(input.id).first<Row>():null;
  const before=existing?rowToConfig(existing):null;
  const codeConflict=await db.prepare("SELECT id FROM city_launch_configs WHERE city_code=? AND id!=?").bind(code,input.id??"").first<Row>();
  if(codeConflict)throw new Error(`City code '${code}' is already used by another city`);
  const id=input.id??`city-${crypto.randomUUID().slice(0,10)}`;
  // The version bump happens in SQL, not here. It used to be computed from `before`, a read taken earlier
  // in this function, and written as `version=excluded.version` - so two operators saving the same city
  // concurrently both read version N and both wrote N+1, leaving two DIFFERENT states carrying the same
  // version number, which the audit trail could neither distinguish nor order. Incrementing the stored
  // value makes concurrent saves monotonic and the recorded version meaningful.
  //
  // This does NOT fix the lost update itself: operator A's coverage is still silently replaced by
  // operator B's. Refusing a save whose base version has moved requires the caller to send the version it
  // read - an API contract change, and a product decision about what the operator is shown on conflict.
  // That half is reported, not decided here. [PTJA-P1-F40]
  const version=before?before.version+1:1;
  /*
   * OPTIMISTIC CONCURRENCY, the half F40 left open. [PTJA-W3-CC]
   *
   * Coverage decides booking eligibility and provider supply, so a silent last-write-wins is not a
   * tidiness problem: B loads the city, A removes a pincode, B saves the list they loaded before A's
   * change, and the pincode is quietly back in service with nobody told. The caller now sends the
   * version it read and the UPDATE only fires while the row still carries it, so the check and the
   * write are ONE statement - a read-then-compare in JavaScript is the same race with more steps.
   *
   * A CREATE has nothing to be stale against, so baseVersion is required only when updating.
   */
  if(before){
    const declared=Number(input.baseVersion);
    if(!Number.isFinite(declared))
      throw Response.json({error:"This save must declare the coverage version it was based on",code:"base_version_required",latestVersion:before.version},{status:400});
    if(declared!==before.version){
      await recordCoverageConflict(db,id,input,actorId,declared,before,now);
      throw Response.json({
        error:"This city's coverage changed while you were editing it. Reload the latest version and reapply your change.",
        code:"coverage_version_conflict",yourVersion:declared,latestVersion:before.version,latest:before,
      },{status:409});
    }
  }
  const row=await db.prepare("INSERT INTO city_launch_configs (id,city_code,city,state,status,centre,radius_km,pincodes,gst_included,services_json,version,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET city_code=excluded.city_code,city=excluded.city,state=excluded.state,status=excluded.status,centre=excluded.centre,radius_km=excluded.radius_km,pincodes=excluded.pincodes,gst_included=excluded.gst_included,services_json=excluded.services_json,version=city_launch_configs.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE city_launch_configs.version=? RETURNING *")
    .bind(id,code,input.city.trim(),input.state.trim(),input.status,input.centre.trim(),input.radiusKm,input.pincodes.trim(),input.gstIncluded?1:0,JSON.stringify(input.services),version,actorId,now,now,before?before.version:0).first<Row>();
  if(!row&&before){
    // The row moved between the check above and this statement - the genuine race, not a stale form.
    const latest=await db.prepare("SELECT * FROM city_launch_configs WHERE id=?").bind(id).first<Row>();
    const current=latest?rowToConfig(latest):null;
    await recordCoverageConflict(db,id,input,actorId,Number(input.baseVersion),current,now);
    throw Response.json({
      error:"This city's coverage changed while you were saving it. Reload the latest version and reapply your change.",
      code:"coverage_version_conflict",yourVersion:Number(input.baseVersion),latestVersion:current?.version??null,latest:current,
    },{status:409});
  }
  // RETURNING, not a re-read. The row was read back with a second SELECT, so when two operators saved the
  // same city concurrently BOTH re-reads saw the final state: each operator was returned - and audited -
  // the other's coverage as what they had just saved. This returns the row THIS statement wrote.
  if(!row)throw new Error("City launch configuration could not be saved");
  const saved=rowToConfig(row);
  await db.prepare("INSERT INTO city_launch_config_audit (id,city_config_id,city,action,before_json,after_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),id,saved.city,before?"update":"create",before?JSON.stringify(before):null,JSON.stringify(saved),actorId,now).run();
  return saved;
}
