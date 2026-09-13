import{authError,requirePermission,requireProviderOwnership,resolveActor,securityAudit}from"../../../../lib/server-auth";
import{APPROVED_MEDIA_UPLOAD_BOUNDARY,ensureMediaBoundaryTables,inspectMediaUploadGrant,redeemMediaUploadGrant}from"../../../../lib/media-upload-boundary";
import{mediaStorageStatus,storeObject}from"../../../../lib/media-storage-adapter";

/**
 * Step 4 of the approved signed-upload rule: the bytes arrive here, with the single-use token the asset
 * was issued, and are stored under that grant's private object key. [PTJA W2-B4-M04, step 4]
 *
 * WHY THIS ROUTE EXISTS. The Partner app registered proof media (POST /api/service-media, which mints the
 * grant) and then stopped: nothing ever carried the file, nothing confirmed it, so every asset stayed at
 * access_status='pending_upload', nobody could review it, "Add service proof" refused with "Approved
 * before and after images are required", grooming could not complete, and after-service payment capture
 * and the founder's verification both waited on a step that did not exist.
 *
 * WHAT IS VERIFIED, AND BY WHOM. The route hashes the bytes it received and compares size, SHA-256 and
 * content type with what the grant promised BEFORE storing anything, so a mismatched or substituted file
 * never reaches storage. With a private bucket bound the object is then written under the grant's key and
 * redeemMediaUploadGrant re-verifies it with a HEAD against the bucket; with no bucket bound the digest
 * this server computed is the observation, reported honestly as adapterConnected:false. In neither case
 * is the caller's word about the object taken: the caller sends bytes, the server measures them.
 *
 * The object key never leaves the server and no URL is composed; the Partner app only ever holds the
 * media id and its single-use token.
 */
type Db=Awaited<ReturnType<typeof database>>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(value:unknown)=>String(value??"").trim();
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer)).map(byte=>byte.toString(16).padStart(2,"0")).join("");

export async function PUT(request:Request){try{
  const db:Db=await database();await ensureMediaBoundaryTables(db);
  const actor=await resolveActor(request);requirePermission(actor,"bookings.view");
  const mediaId=text(request.headers.get("x-pawspace-media-id")),token=text(request.headers.get("x-pawspace-upload-token"));
  if(!mediaId||!token)return json({error:"The media asset id and its upload token are required as headers"},400);
  const grant=await inspectMediaUploadGrant(db,{token,mediaId});
  await requireProviderOwnership(db,actor,grant.providerId);

  const declaredType=text(request.headers.get("content-type")).split(";")[0].toLowerCase();
  if(declaredType!==grant.mimeType)return json({error:"The uploaded content type does not match the upload grant",code:"object_type_mismatch",expected:grant.mimeType},409);
  const ceiling=APPROVED_MEDIA_UPLOAD_BOUNDARY.maxSizeBytes,declaredLength=Number(request.headers.get("content-length")||"0");
  if(Number.isFinite(declaredLength)&&declaredLength>ceiling)return json({error:`Media must be at most ${ceiling} bytes`,code:"media_size_out_of_range"},413);
  const bytes=new Uint8Array(await request.arrayBuffer());
  if(!bytes.byteLength)return json({error:"The upload body is empty"},400);
  if(bytes.byteLength>ceiling)return json({error:`Media must be at most ${ceiling} bytes`,code:"media_size_out_of_range"},413);
  if(bytes.byteLength!==grant.sizeBytes)return json({error:"The uploaded object's size does not match the upload grant",code:"object_size_mismatch",expected:grant.sizeBytes,observed:bytes.byteLength},409);
  const sha256=hex(await crypto.subtle.digest("SHA-256",bytes));
  if(sha256!==grant.sha256)return json({error:"The uploaded object's checksum does not match the upload grant",code:"object_checksum_mismatch"},409);

  const stored=await storeObject(grant.objectKey,bytes,grant.mimeType);
  const storage=await mediaStorageStatus();
  if(storage.connected&&!stored.stored){
    await securityAudit(db,actor,"service_media.upload","booking",grant.bookingId,"blocked",{mediaId,objectKey:grant.objectKey,reason:stored.reason});
    return json({error:"Private storage did not accept the object; nothing was registered",code:"object_store_failed"},503);
  }
  const result=await redeemMediaUploadGrant(db,{token,objectKey:grant.objectKey,observed:{sizeBytes:bytes.byteLength,sha256,mimeType:grant.mimeType},actorId:actor.email});
  await securityAudit(db,actor,"service_media.upload","booking",grant.bookingId,"completed",{mediaId,objectKey:grant.objectKey,sizeBytes:bytes.byteLength,sha256,objectStored:stored.stored,adapterConnected:storage.connected,verifiedBy:"server_digest"});
  return json({data:{id:mediaId,ref:result.mediaRef,bookingId:grant.bookingId,accessStatus:result.accessStatus,reviewStatus:result.reviewStatus,proofReady:false,
    sizeBytes:bytes.byteLength,sha256,objectStored:stored.stored,adapterConnected:storage.connected,
    next:"A second person must approve this photo in the Control Center (Service proof review) before it counts as service proof."}});
}catch(error){return authError(error,"Unable to upload service media");}}
