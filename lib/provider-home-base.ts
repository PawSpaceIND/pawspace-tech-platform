type Db=D1Database;
type Row=Record<string,unknown>;

// Home-base reads are fanned out for the provider shortlist. Steady-state matching must not issue
// idempotent schema writes: under concurrent D1 traffic those writes serialize otherwise independent
// assignments. The probe is schema-only; provider location data is still read fresh for every match.
const homeBaseTablesReady=new WeakSet<Db>();
const homeBaseTablesRunning=new WeakMap<Db,Promise<void>>();
async function homeBaseSchemaReady(db:Db){
 try{const rows=await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('provider_home_base','idx_provider_home_base_provider')").all<Row>();return new Set(rows.results.map(row=>String(row.name))).size===2;}catch{return false;}
}
export async function ensureProviderHomeBaseTables(db:Db){
 if(homeBaseTablesReady.has(db))return;
 const running=homeBaseTablesRunning.get(db);if(running)return running;
 const pending=(async()=>{
  if(await homeBaseSchemaReady(db))return;
  await db.prepare("CREATE TABLE IF NOT EXISTS provider_home_base (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,address TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,effective_from INTEGER NOT NULL,effective_until INTEGER,reason TEXT NOT NULL,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_home_base_provider ON provider_home_base(provider_id,effective_from)").run();
 })().then(()=>{homeBaseTablesReady.add(db);});
 homeBaseTablesRunning.set(db,pending);
 try{await pending;}finally{if(homeBaseTablesRunning.get(db)===pending)homeBaseTablesRunning.delete(db);}
}

function text(v:unknown){return String(v??"").trim();}

export async function saveProviderHomeBase(db:Db,input:{providerId:string;address:string;latitude:number;longitude:number;effectiveFrom:number;reason:string;actorId:string}){
 await ensureProviderHomeBaseTables(db);
 if(!text(input.providerId)||!text(input.address))throw new Error("Provider and a real geocoded address are required");
 if(!Number.isFinite(input.latitude)||!Number.isFinite(input.longitude)||Math.abs(input.latitude)>90||Math.abs(input.longitude)>180)throw new Error("Home base requires real, valid latitude and longitude - not a placeholder");
 if(!Number.isFinite(input.effectiveFrom)||input.effectiveFrom<=0)throw new Error("A real effective-from date is required");
 if(input.reason.trim().length<8)throw new Error("A real reason (at least 8 characters) is required to change a provider's home base");
 const now=Date.now();
 // Close out the prior active record, if any, exactly at the moment the new one starts - never leaves two "active" bases overlapping.
 await db.prepare("UPDATE provider_home_base SET effective_until=? WHERE provider_id=? AND effective_until IS NULL").bind(input.effectiveFrom,input.providerId).run();
 const id=`PHB-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 await db.prepare("INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) VALUES (?,?,?,?,?,?,NULL,?,?,?)")
   .bind(id,input.providerId,input.address.trim(),input.latitude,input.longitude,input.effectiveFrom,input.reason.trim(),input.actorId,now).run();
 return{id,providerId:input.providerId,address:input.address.trim(),latitude:input.latitude,longitude:input.longitude,effectiveFrom:input.effectiveFrom};
}

export async function currentHomeBase(db:Db,providerId:string,at=Date.now()){
 await ensureProviderHomeBaseTables(db);
 const row=await db.prepare("SELECT * FROM provider_home_base WHERE provider_id=? AND effective_from<=? AND (effective_until IS NULL OR effective_until>?) ORDER BY effective_from DESC LIMIT 1")
   .bind(providerId,at,at).first<Row>();
 if(!row)return null;
 return{id:String(row.id),providerId:String(row.provider_id),address:String(row.address),latitude:Number(row.latitude),longitude:Number(row.longitude),effectiveFrom:Number(row.effective_from),effectiveUntil:row.effective_until==null?null:Number(row.effective_until)};
}

export async function homeBaseHistory(db:Db,providerId:string){
 await ensureProviderHomeBaseTables(db);
 const rows=await db.prepare("SELECT * FROM provider_home_base WHERE provider_id=? ORDER BY effective_from DESC").bind(providerId).all<Row>();
 return rows.results.map(row=>({id:String(row.id),address:String(row.address),latitude:Number(row.latitude),longitude:Number(row.longitude),effectiveFrom:Number(row.effective_from),effectiveUntil:row.effective_until==null?null:Number(row.effective_until),reason:String(row.reason),updatedBy:String(row.updated_by)}));
}
