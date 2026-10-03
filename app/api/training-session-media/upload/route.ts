import{authError,requirePermission,requireProviderOwnership,resolveActor,securityAudit}from"../../../../lib/server-auth";
import{APPROVED_MEDIA_UPLOAD_BOUNDARY,ensureMediaBoundaryTables,inspectMediaUploadGrant,redeemMediaUploadGrant}from"../../../../lib/media-upload-boundary";
import{mediaStorageStatus,storeObject}from"../../../../lib/media-storage-adapter";

/** Training-only video bytes: bounded stream, server digest, private storage and one-use grant.
 * Registration and upload do not claim approval or delivery; playback requires the existing review gate.
 */
type Db=Awaited<ReturnType<typeof database>>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(value:unknown)=>String(value??"").trim();
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer)).map(byte=>byte.toString(16).padStart(2,"0")).join("");

export async function PUT(request:Request){try{
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return json({error:"Cross-origin Training upload blocked"},403);
  const db:Db=await database();await ensureMediaBoundaryTables(db);
  const actor=await resolveActor(request);requirePermission(actor,"bookings.view");
  const mediaId=text(request.headers.get("x-pawspace-media-id")),token=text(request.headers.get("x-pawspace-upload-token"));
  if(!mediaId||!token)return json({error:"The media asset id and its upload token are required as headers"},400);
  const grant=await inspectMediaUploadGrant(db,{token,mediaId,trainingVideoUpload:true});
  const link=await db.prepare("SELECT a.purpose FROM training_session_media_links l JOIN service_media_assets a ON a.id=l.media_id WHERE l.media_id=? AND l.provider_id=?").bind(mediaId,grant.providerId).first<Record<string,unknown>>();
  if(link?.purpose!=="training_video")return json({error:"A Training video upload grant is required"},403);
  if(!(await mediaStorageStatus()).connected)return json({error:"Private video storage is unavailable; no video was registered"},503);
  await requireProviderOwnership(db,actor,grant.providerId);

  const declaredType=text(request.headers.get("content-type")).split(";")[0].toLowerCase();
  if(declaredType!==grant.mimeType)return json({error:"The uploaded content type does not match the upload grant",code:"object_type_mismatch",expected:grant.mimeType},409);
  const ceiling=APPROVED_MEDIA_UPLOAD_BOUNDARY.maxSizeBytes,declaredLength=Number(request.headers.get("content-length")||"0");
  if(Number.isFinite(declaredLength)&&declaredLength>ceiling)return json({error:`Media must be at most ${ceiling} bytes`,code:"media_size_out_of_range"},413);
  const reader=request.body?.getReader();if(!reader)return json({error:"The upload body is empty"},400);
  const chunks:Uint8Array[]=[];let total=0;
  while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>ceiling){await reader.cancel();return json({error:"Training video exceeds the upload size limit"},413);}chunks.push(part.value);}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  if(!bytes.byteLength)return json({error:"The upload body is empty"},400);
  if(bytes.byteLength>ceiling)return json({error:`Media must be at most ${ceiling} bytes`,code:"media_size_out_of_range"},413);
  if(bytes.byteLength!==grant.sizeBytes)return json({error:"The uploaded object's size does not match the upload grant",code:"object_size_mismatch",expected:grant.sizeBytes,observed:bytes.byteLength},409);
  const validContainer=grant.mimeType==="video/mp4"?bytes.length>=12&&String.fromCharCode(...bytes.slice(4,8))==="ftyp":grant.mimeType==="video/webm"&&bytes.length>=4&&bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3;
  if(!validContainer)return json({error:"The video container does not match its declared format"},400);
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
    next:"A second person must approve this video in the Control Center (Service proof review) before it counts as service proof."}});
}catch(error){return authError(error,"Unable to upload service media");}}
