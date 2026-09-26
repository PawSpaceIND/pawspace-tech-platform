import{governedJsonError}from"./governed-http-error";
import{storeObject}from"./media-storage-adapter";

/**
 * The provider-side upload step for Boarding, Pet Sitting and Pet Taxi proof photos. [PARTNER-02]
 *
 * WHY THIS EXISTS. prepare_media hands the partner a single-use upload token, and the only step that
 * moved an asset off access_status='pending_upload' was sandbox_finalize_media - a staff-only action that
 * needs that token, which only the partner's browser ever held. No page called it, so every partner photo
 * stayed "awaiting upload confirmation" for ever, nothing reached scan review, the daily Boarding
 * milestone could never be met and no stay could be checked out.
 *
 * WHAT THIS DOES INSTEAD, following the grooming upload route (app/api/service-media/upload): the
 * partner sends the BYTES with the token, and the server measures them against what prepare_media
 * declared - content type, exact size, SHA-256 - before anything is stored or any state moves. The
 * caller's word about the object is never taken, so this is not the partner self-declaring storage (that
 * is still what staff-only sandbox_finalize_media means). With a private bucket bound the bytes are
 * stored under a server-chosen key; without one nothing is kept and the result says objectStored:false.
 * Either way the asset only reaches quarantine with scan_status='pending': a second person must still
 * record the scan decision before it can be used as proof.
 */
type Row=Record<string,unknown>;
export type PartnerProofUpload={contentType:string;bytes:Uint8Array<ArrayBuffer>};
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer)).map(byte=>byte.toString(16).padStart(2,"0")).join("");

/** Reads a PUT body after authorization, refusing an oversized declaration before the bytes are buffered. */
export async function readPartnerProofUpload(request:Request,maxBytes:number):Promise<PartnerProofUpload>{const declared=Number(request.headers.get("content-length")||"0");if(Number.isFinite(declared)&&declared>maxBytes)throw governedJsonError({error:`Proof uploads must be at most ${Math.round(maxBytes/1_000_000)} MB`,code:"media_size_out_of_range"},413);const bytes=new Uint8Array(await request.arrayBuffer());if(!bytes.byteLength)throw governedJsonError({error:"The upload body is empty",code:"media_upload_empty"},400);if(bytes.byteLength>maxBytes)throw governedJsonError({error:`Proof uploads must be at most ${Math.round(maxBytes/1_000_000)} MB`,code:"media_size_out_of_range"},413);return{contentType:String(request.headers.get("content-type")||""),bytes};}

/** Verifies the received bytes against the prepared asset row, then stores them if a private bucket is bound. */
export async function verifyAndStorePartnerProof(media:Row,upload:PartnerProofUpload,storageKey:string,label:string){const contentType=String(upload.contentType||"").split(";")[0].trim().toLowerCase(),bytes=upload.bytes;if(!bytes?.byteLength)throw governedJsonError({error:"The upload body is empty",code:"media_upload_empty"},400);if(contentType!==String(media.mime_type))throw governedJsonError({error:`The uploaded file type does not match the prepared ${label}`,code:"object_type_mismatch",expected:String(media.mime_type)},409);if(bytes.byteLength!==Number(media.size_bytes))throw governedJsonError({error:`The uploaded file size does not match the prepared ${label}`,code:"object_size_mismatch"},409);const sha256=hex(await crypto.subtle.digest("SHA-256",bytes));if(sha256!==String(media.sha256).toLowerCase())throw governedJsonError({error:`The uploaded file checksum does not match the prepared ${label}`,code:"object_checksum_mismatch"},409);const stored=await storeObject(storageKey,bytes,contentType);if(stored.adapterConnected&&!stored.stored)throw governedJsonError({error:"Private storage did not accept the photo; nothing was registered",code:"object_store_failed"},409);return{sha256,sizeBytes:bytes.byteLength,objectStored:stored.stored,adapterConnected:stored.adapterConnected};}

/**
 * [PARTNER-04] Incident evidence that is not yet usable (awaiting verification, rejected, wrong slot)
 * used to fail the whole incident with a redacted, generic 409. The refusal stands - an unverified photo
 * is never attached as evidence - but it now says what happened and how to proceed, so an incident is
 * never silently lost behind a photo.
 */
export async function incidentEvidence<T>(pending:Promise<T>):Promise<T>{try{return await pending;}catch(error){if(error instanceof Response&&error.status===409){const detail=(await error.clone().text().catch(()=>"")).trim();throw governedJsonError({error:`${detail?`${detail}. `:""}The incident was not recorded. Report it without this photo, or attach the photo after PawSpace Operations has verified it.`,code:"incident_media_not_verified"},409);}throw error;}}
