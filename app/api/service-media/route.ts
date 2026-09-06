import{authError,requirePermission,requireProviderOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{deleteMedia,ensureMediaBoundaryTables,issueMediaReadGrant,issueMediaUploadGrant,redeemMediaUploadGrant,replaceMedia,resolveMediaReadGrant,reviewMedia}from"../../../lib/media-upload-boundary";

type Db=Awaited<ReturnType<typeof database>>;
type Row=Record<string,unknown>;
type MediaPurpose="before_service"|"after_service"|"service_issue"|"training_homework"|"stay_update";
type RegisterInput={bookingId:string;purpose:MediaPurpose;mimeType:string;sizeBytes:number;sha256:string;fileName?:string;cityId?:string};
type MediaActionInput={id:string;action:"confirm_upload"|"record_scan"|"revoke"|"replace"|"share"|"delete";scanResult?:"clean"|"rejected";storageReference?:string;uploadToken?:string;observedSizeBytes?:number;observedSha256?:string;observedMimeType?:string;audience?:string;mimeType?:string;sizeBytes?:number;sha256?:string;fileName?:string;reason?:string};

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
async function ensureTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS service_media_assets (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,purpose TEXT NOT NULL,storage_key TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,scan_status TEXT NOT NULL DEFAULT 'pending',access_status TEXT NOT NULL DEFAULT 'pending_upload',retention_status TEXT NOT NULL DEFAULT 'active',synthetic INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS service_media_events (id TEXT PRIMARY KEY,media_id TEXT NOT NULL,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
]);}
async function mediaEvent(db:Db,mediaId:string,bookingId:string,eventType:string,actorId:string,detail:unknown){await db.prepare("INSERT INTO service_media_events (id,media_id,booking_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),mediaId,bookingId,eventType,actorId,JSON.stringify(detail),Date.now()).run();}

/**
 * Two readers. A signed read token (step 8) is resolved on its own merits - it is the customer's link,
 * it carries no staff permission, and it stops working when it expires or when the media is withdrawn.
 * Everything else is the staff listing and still needs bookings.view plus provider ownership.
 */
export async function GET(request:Request){try{const db=await database();await ensureTables(db);await ensureMediaBoundaryTables(db);
  const grantToken=(new URL(request.url).searchParams.get("grant")||"").trim();
  if(grantToken){const read=await resolveMediaReadGrant(db,grantToken);return json({data:{mediaId:read.mediaId,mimeType:read.mimeType,expiresAt:read.expiresAt,audience:read.audience,adapterConnected:false,objectDelivered:false}});}
  const actor=await resolveActor(request);requirePermission(actor,"bookings.view");const url=new URL(request.url),bookingId=(url.searchParams.get("bookingId")||"").trim();if(!bookingId)return json({error:"Booking ID is required"},400);const work=await db.prepare("SELECT provider_id FROM provider_work_orders WHERE booking_id=?").bind(bookingId).first<Row>();if(!work)return json({error:"Provider work order not found"},404);await requireProviderOwnership(db,actor,String(work.provider_id));const assets=await db.prepare("SELECT id,booking_id,provider_id,purpose,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_at,updated_at FROM service_media_assets WHERE booking_id=? ORDER BY created_at").bind(bookingId).all<Row>();return json({bookingId,assets:assets.results.map(row=>({...row,ref:`media://asset/${String(row.id)}`,proofReady:String(row.scan_status)==="clean"&&String(row.access_status)==="ready"&&String(row.retention_status)==="active"&&Number(row.synthetic||0)===0}))});}catch(error){return authError(error,"Unable to load service media");}}

/**
 * Steps 1-3 of the approved signed-upload rule. This route used to answer
 * storage:{mode:"not_connected"} and mint no grant at all, which left confirmation open to any
 * bookings.manage actor with any opaque string. The grant now comes from lib/media-upload-boundary,
 * the single authority the four sibling proof libraries and Training media share. [PTJA-W2-B4-M04]
 */
export async function POST(request:Request){try{const input=await request.json() as RegisterInput;if(!input.bookingId||!input.purpose||!input.mimeType||!Number.isFinite(input.sizeBytes)||!input.sha256)return json({error:"Booking, purpose, MIME type, size and checksum are required"},400);
  const db=await database();await ensureTables(db);await ensureMediaBoundaryTables(db);const actor=await resolveActor(request);requirePermission(actor,"bookings.view");const work=await db.prepare("SELECT provider_id,service_code FROM provider_work_orders WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!work)return json({error:"Provider work order not found"},404);await requireProviderOwnership(db,actor,String(work.provider_id));
  const grant=await issueMediaUploadGrant(db,{bookingId:input.bookingId,scopeType:"booking",scopeId:input.bookingId,providerId:String(work.provider_id),serviceCode:String(work.service_code),cityId:input.cityId??null,category:input.purpose,mimeType:input.mimeType,sizeBytes:input.sizeBytes,sha256:input.sha256,fileName:input.fileName,actorId:actor.email});
  await securityAudit(db,actor,"service_media.prepare","booking",input.bookingId,"completed",{mediaId:grant.mediaId,purpose:input.purpose,providerId:work.provider_id,synthetic:false,grantId:grant.grantId,policyVersion:grant.policyVersion});
  return json({data:{id:grant.mediaId,ref:grant.mediaRef,bookingId:input.bookingId,providerId:String(work.provider_id),purpose:input.purpose,scanStatus:"pending",accessStatus:"pending_upload",reviewStatus:grant.reviewStatus,proofReady:false,synthetic:false,policyVersion:grant.policyVersion,upload:{token:grant.token,objectKey:grant.objectKey,expiresAt:grant.expiresAt,mimeType:grant.mimeType,sizeBytes:grant.sizeBytes,sha256:grant.sha256,singleUse:true,adapterConnected:false,rawPublicUrl:false}}},201);
}catch(error){return authError(error,"Unable to prepare service media");}}

/**
 * Steps 5-7 and 9. Confirmation now redeems the single-use grant this asset was issued and verifies the
 * stored object against what was declared; review is a separate person's decision with a reason; and
 * replacement, revocation and sharing are each audited.
 *
 * What changed for callers: `confirm_upload` requires `uploadToken` plus the observed size, checksum
 * and content type of the stored object, and `record_scan` requires a `reason`. Before this, a single
 * bookings.manage identity could POST a record for any booking with a work order, confirm it with a
 * string of their own choosing, mark it clean, and have assertServiceProofRef - the mandatory
 * before/after photo gate on grooming completion - accept the result. [PTJA-W2-B4-M04]
 */
export async function PATCH(request:Request){try{const input=await request.json() as MediaActionInput;if(!input.id||!input.action)return json({error:"Media ID and action are required"},400);const db=await database();await ensureTables(db);await ensureMediaBoundaryTables(db);const actor=await resolveActor(request);const asset=await db.prepare("SELECT * FROM service_media_assets WHERE id=?").bind(input.id).first<Row>();if(!asset)return json({error:"Service media asset not found"},404);const work=await db.prepare("SELECT provider_id FROM provider_work_orders WHERE booking_id=?").bind(asset.booking_id).first<Row>();if(!work)return json({error:"Provider work order not found"},404);const now=Date.now();
  if(input.action==="confirm_upload"){
    requirePermission(actor,"bookings.view");
    const result=await redeemMediaUploadGrant(db,{token:String(input.uploadToken||""),objectKey:String(input.storageReference||""),observed:{sizeBytes:Number(input.observedSizeBytes),sha256:String(input.observedSha256||""),mimeType:String(input.observedMimeType||"")},actorId:actor.email});
    if(result.mediaId!==input.id)return json({error:"This upload token belongs to another media asset"},403);
    await securityAudit(db,actor,"service_media.confirm_upload","booking",String(asset.booking_id),"completed",{mediaId:input.id,objectKey:result.objectKey});
    return json({data:{id:input.id,scanStatus:"pending",accessStatus:result.accessStatus,reviewStatus:result.reviewStatus,proofReady:false}});
  }
  if(input.action==="record_scan"){
    requirePermission(actor,"bookings.manage");if(!["clean","rejected"].includes(String(input.scanResult)))return json({error:"Scan result must be clean or rejected"},400);
    // Maker/checker, the line all four sibling proof libraries carry, now enforced in the shared
    // authority rather than here: without it one identity could POST the record, confirm the upload and
    // mark its OWN asset clean.
    const decision=input.scanResult==="clean"?"approved":"rejected";
    const result=await reviewMedia(db,{mediaId:input.id,decision,actorId:actor.email,reason:String(input.reason||"")});
    await securityAudit(db,actor,"service_media.scan","booking",String(asset.booking_id),"completed",{mediaId:input.id,result:input.scanResult,reviewStatus:result.reviewStatus});
    return json({data:{id:input.id,scanStatus:decision==="approved"?"clean":"rejected",accessStatus:result.accessStatus,reviewStatus:result.reviewStatus,proofReady:result.proofReady}});
  }
  if(input.action==="replace"){
    requirePermission(actor,"bookings.view");
    const replacement=await replaceMedia(db,{mediaId:input.id,actorId:actor.email,reason:String(input.reason||""),mimeType:String(input.mimeType||""),sizeBytes:Number(input.sizeBytes),sha256:String(input.sha256||""),fileName:input.fileName});
    await securityAudit(db,actor,"service_media.replace","booking",String(asset.booking_id),"completed",{mediaId:input.id,replacedBy:replacement.mediaId,reason:String(input.reason||"")});
    return json({data:{id:replacement.mediaId,ref:replacement.mediaRef,supersedes:input.id,reviewStatus:replacement.reviewStatus,proofReady:false,upload:{token:replacement.token,objectKey:replacement.objectKey,expiresAt:replacement.expiresAt,singleUse:true,adapterConnected:false}}},201);
  }
  if(input.action==="share"){
    // Step 8. The customer never receives the private object key - only a token that stops working.
    requirePermission(actor,"bookings.manage");
    const read=await issueMediaReadGrant(db,{mediaId:input.id,audience:String(input.audience||"customer"),actorId:actor.email});
    await securityAudit(db,actor,"service_media.share","booking",String(asset.booking_id),"completed",{mediaId:input.id,audience:read.audience,expiresAt:read.expiresAt});
    return json({data:{id:input.id,url:read.url,expiresAt:read.expiresAt,audience:read.audience,adapterConnected:false}});
  }
  // Revoke happens only when revoke is ASKED FOR. This tail used to be unguarded: after the two `if`
  // blocks above, any action string the handler did not recognise fell straight through to the revoke
  // UPDATE. Measured: PATCH {"action":"record_scann"} - one letter different from the real action name -
  // returned 200 and irreversibly revoked an approved proof asset, with no error, no path back through
  // this route, and a service_media_events row reading "Revoked by authorized operator" - an audit trail
  // asserting a deliberate revocation the operator never requested. The declared type already says the
  // action is one of a fixed set; this enforces that at runtime instead of only at compile time.
  if(input.action==="delete"){
    // Step 9, deletion. Distinct from revoke: revoke withdraws access and keeps the record active for
    // retention, delete ends retention. Both are audited; neither is silent.
    requirePermission(actor,"bookings.manage");
    const removed=await deleteMedia(db,{mediaId:input.id,actorId:actor.email,reason:String(input.reason||"")});
    await securityAudit(db,actor,"service_media.delete","booking",String(asset.booking_id),"completed",{mediaId:input.id,reason:String(input.reason||"")});
    return json({data:{id:input.id,accessStatus:removed.accessStatus,retentionStatus:removed.retentionStatus,proofReady:false}});
  }
  if(input.action!=="revoke")return json({error:"Unsupported service media action"},400);
  requirePermission(actor,"bookings.manage");await db.prepare("UPDATE service_media_assets SET access_status='revoked',retention_status='revoked',updated_at=? WHERE id=?").bind(now,input.id).run();await db.prepare("UPDATE media_read_grants SET revoked_at=? WHERE media_id=? AND revoked_at IS NULL").bind(now,input.id).run();await db.prepare("UPDATE media_upload_grants SET status='revoked' WHERE media_id=? AND status='issued'").bind(input.id).run();await mediaEvent(db,input.id,String(asset.booking_id),"media_revoked",actor.email,{reason:input.reason||"Revoked by authorized operator"});await securityAudit(db,actor,"service_media.revoke","booking",String(asset.booking_id),"completed",{mediaId:input.id,reason:input.reason||null});return json({data:{id:input.id,accessStatus:"revoked",retentionStatus:"revoked",proofReady:false}});
}catch(error){return authError(error,"Unable to update service media");}}
