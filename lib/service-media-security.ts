type Row=Record<string,unknown>;
type Db=D1Database;

export async function ensureServiceMediaTable(db:Db){await db.prepare("CREATE TABLE IF NOT EXISTS service_media_assets (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,purpose TEXT NOT NULL,storage_key TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,scan_status TEXT NOT NULL DEFAULT 'clean',access_status TEXT NOT NULL DEFAULT 'ready',retention_status TEXT NOT NULL DEFAULT 'active',synthetic INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();}

export async function assertServiceProofRef(db:Db,input:{ref:string|undefined;bookingId:string;providerId:string;purpose:"before_service"|"after_service"}){
  const value=input.ref?.trim();if(!value)return;
  if(value.startsWith("uat://proof/")){
    const expected=`uat://proof/${input.bookingId}/${input.purpose==="before_service"?"before":"after"}`;
    if(value!==expected)throw new Response("Synthetic proof reference does not belong to this booking/purpose",{status:409});
    return;
  }
  const prefix="media://asset/";
  if(!value.startsWith(prefix))throw new Response("Proof must use a PawSpace service-media reference",{status:400});
  const id=value.slice(prefix.length).trim();if(!id||id.includes("/")||id.includes("?")||id.includes("#"))throw new Response("Invalid PawSpace media asset reference",{status:400});
  await ensureServiceMediaTable(db);
  const row=await db.prepare("SELECT booking_id,provider_id,purpose,scan_status,access_status,retention_status FROM service_media_assets WHERE id=?").bind(id).first<Row>();
  if(!row)throw new Response("Service media asset does not exist",{status:409});
  if(String(row.booking_id)!==input.bookingId)throw new Response("Service media asset belongs to another booking",{status:403});
  if(String(row.provider_id)!==input.providerId)throw new Response("Service media asset belongs to another provider",{status:403});
  if(String(row.purpose)!==input.purpose)throw new Response("Service media asset purpose does not match the proof slot",{status:409});
  if(String(row.scan_status)!=="clean"||String(row.access_status)!=="ready"||String(row.retention_status)!=="active")throw new Response("Service media asset is not safe and ready for proof",{status:409});
}
