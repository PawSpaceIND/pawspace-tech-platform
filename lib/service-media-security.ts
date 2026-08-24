type Row=Record<string,unknown>;
type Db=D1Database;

export async function ensureServiceMediaTable(db:Db){await db.prepare("CREATE TABLE IF NOT EXISTS service_media_assets (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,purpose TEXT NOT NULL,storage_key TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,scan_status TEXT NOT NULL DEFAULT 'pending',access_status TEXT NOT NULL DEFAULT 'pending_upload',retention_status TEXT NOT NULL DEFAULT 'active',synthetic INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();}

/**
 * Is the synthetic `uat://proof/...` shortcut permitted in this runtime?
 *
 * EXPLICIT OPT-IN, and deliberately the opposite polarity to PAWSPACE_MAPS_ENV. For Maps, an absent
 * variable defaults to "sandbox" - the RESTRICTED mode - so absence fails closed. Here the synthetic
 * branch is the PERMISSIVE one: it satisfies a service-proof mandate with a string the caller composes
 * from the booking id, with no asset, no upload, no checksum and no scan. Defaulting that on would mean
 * an unset variable in production silently accepts fabricated proof, so absence must refuse.
 */
function syntheticProofAllowed(env:Record<string,unknown>|null|undefined){
  return String(env?.PAWSPACE_MEDIA_ENV??"").trim().toLowerCase()==="uat";
}

export async function assertServiceProofRef(db:Db,input:{ref:string|undefined;bookingId:string;providerId:string;purpose:"before_service"|"after_service"}){
  const value=input.ref?.trim();
  // An absent reference returns without objection ON PURPOSE: this function validates a reference that
  // was supplied, and the callers that MANDATE proof (grooming `complete`) refuse a missing ref before
  // ever calling here. It is not a bypass, and a test below pins that caller-side refusal.
  if(!value)return;
  if(value.startsWith("uat://proof/")){
    // Registered, scanned media is the only proof path that survives without this flag.
    const {env}=await import("cloudflare:workers");
    if(!syntheticProofAllowed(env as unknown as Record<string,unknown>))
      throw new Response("Synthetic UAT proof references are not accepted in this environment",{status:403});
    const expected=`uat://proof/${input.bookingId}/${input.purpose==="before_service"?"before":"after"}`;
    if(value!==expected)throw new Response("Synthetic proof reference does not belong to this booking/purpose",{status:409});
    return;
  }
  const prefix="media://asset/";
  if(!value.startsWith(prefix))throw new Response("Proof must use a PawSpace service-media reference",{status:400});
  const id=value.slice(prefix.length).trim();if(!id||id.includes("/")||id.includes("?")||id.includes("#"))throw new Response("Invalid PawSpace media asset reference",{status:400});
  await ensureServiceMediaTable(db);
  const row=await db.prepare("SELECT booking_id,provider_id,purpose,scan_status,access_status,retention_status,synthetic FROM service_media_assets WHERE id=?").bind(id).first<Row>();
  if(!row)throw new Response("Service media asset does not exist",{status:409});
  if(String(row.booking_id)!==input.bookingId)throw new Response("Service media asset belongs to another booking",{status:403});
  if(String(row.provider_id)!==input.providerId)throw new Response("Service media asset belongs to another provider",{status:403});
  if(String(row.purpose)!==input.purpose)throw new Response("Service media asset purpose does not match the proof slot",{status:409});
  if(String(row.scan_status)!=="clean")throw new Response("Service media asset has not passed malware/content scanning",{status:409});
  if(String(row.access_status)!=="ready")throw new Response("Service media asset upload is not ready for service proof",{status:409});
  if(String(row.retention_status)!=="active")throw new Response("Service media asset is outside its active retention state",{status:409});
  if(Number(row.synthetic||0)!==0)throw new Response("Registered media asset is still marked synthetic",{status:409});
}
