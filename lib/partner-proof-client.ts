import{boundedFetch}from"./bounded-fetch";

/**
 * Browser half of the Boarding / Pet Sitting / Pet Taxi proof upload. [PARTNER-02]
 *
 * prepare_media only registers a photo and hands back a single-use token; the photo is not evidence
 * until its bytes reach the server, which checks them against the declaration, and a second person has
 * verified it. These helpers are the one place the partner pages carry the bytes and read the state, so
 * a page cannot stop after "prepared" again, and cannot mistake "uploaded" for "usable".
 */
export type PartnerProofState="awaiting_upload"|"awaiting_verification"|"verified"|"rejected"|"withdrawn"|"blocked";
type MediaRow={scan_status?:unknown;access_status?:unknown;retention_status?:unknown;synthetic?:unknown};

/** The same rule the proof libraries' proofAsset() gate enforces, as a label instead of a throw. */
export function partnerProofState(row:MediaRow):PartnerProofState{const scan=String(row.scan_status??""),access=String(row.access_status??""),retention=String(row.retention_status??"active");if(retention!=="active"||access==="revoked")return"withdrawn";if(scan==="rejected")return"rejected";if(access==="pending_upload")return"awaiting_upload";if(access==="quarantined"&&scan==="pending")return"awaiting_verification";if(scan==="clean"&&access==="ready"&&Number(row.synthetic??0)===0)return"verified";return"blocked";}
export const PARTNER_PROOF_STATE_TEXT:Record<PartnerProofState,string>={awaiting_upload:"Registered · the photo itself has not been uploaded",awaiting_verification:"Uploaded and checksum-verified · awaiting PawSpace Operations verification",verified:"Verified · usable as proof",rejected:"Rejected at verification · upload a replacement",withdrawn:"Withdrawn",blocked:"Not usable as proof"};
export const isVerifiedProof=(row:MediaRow)=>partnerProofState(row)==="verified";

export async function proofFileSha256(file:Blob){const hash=await crypto.subtle.digest("SHA-256",await file.arrayBuffer());return Array.from(new Uint8Array(hash)).map(byte=>byte.toString(16).padStart(2,"0")).join("");}

export type PartnerProofUploadResult={mediaId?:string;mediaRef?:string;status?:string;scanStatus?:string;accessStatus?:string;proofReady?:boolean;objectStored?:boolean;adapterConnected?:boolean};
/** PUT a prepared photo's bytes to its service route with the token prepare_media returned. */
export async function uploadPartnerProofBytes(path:string,input:{mediaId:string;uploadToken:string;file:Blob}){if(!input.mediaId||!input.uploadToken)throw new Error("The proof photo was registered without an upload grant; choose the photo again");const response=await boundedFetch(path,{method:"PUT",headers:{"content-type":input.file.type,"x-pawspace-media-id":input.mediaId,"x-pawspace-upload-token":input.uploadToken},body:input.file},60_000);const body=await response.json().catch(()=>({})) as {data?:PartnerProofUploadResult;error?:string};if(!response.ok||!body.data)throw new Error(body.error||"The proof photo could not be uploaded");return body.data;}

/**
 * Staff side: the Booking Command Center's verification of Boarding / Pet Sitting / Pet Taxi proof.
 * Grooming before/after photos are reviewed through /api/service-media; these three services keep their
 * own governed proof APIs, whose record_media_scan action is the decision (bookings.manage, and the
 * person who submitted a photo can never decide on it).
 */
export type PartnerProofService="boarding"|"pet_sitting"|"pet_taxi";
export type PartnerProofMedia={id:string;purpose:string;mime_type?:string;size_bytes?:number;scan_status:string;access_status:string;retention_status?:string;synthetic?:number;object_stored?:number|null;created_at:number;updated_at?:number};
export const PARTNER_PROOF_SERVICES:Record<PartnerProofService,{title:string;endpoint:string;scopeKey:"stayId"|"bookingId";use:string;purposes:Record<string,string>}>={
 boarding:{title:"Boarding",endpoint:"/api/boarding-proof",scopeKey:"stayId",use:"daily stay updates, medication records and incidents (every stay day needs a verified photo before check-out)",purposes:{boarding_checkin:"Check-in photo",stay_update:"Daily stay update",boarding_medication:"Medication evidence",boarding_incident:"Incident evidence",boarding_checkout:"Check-out photo"}},
 pet_sitting:{title:"Pet Sitting",endpoint:"/api/sitting-proof",scopeKey:"bookingId",use:"care updates, medication records and incidents",purposes:{sitting_checkin:"Check-in photo",sitting_update:"Care update",sitting_medication:"Medication evidence",sitting_incident:"Incident evidence",sitting_checkout:"Check-out photo"}},
 pet_taxi:{title:"Pet Taxi",endpoint:"/api/taxi-proof",scopeKey:"bookingId",use:"the before/after trip pictures and incidents",purposes:{taxi_update:"Before picture",taxi_dropoff:"After picture",taxi_incident:"Incident evidence"}},
};
export const isPartnerProofService=(code:string):code is PartnerProofService=>Object.prototype.hasOwnProperty.call(PARTNER_PROOF_SERVICES,code);
async function readJson<T>(response:Response,fallback:string){const body=await response.json().catch(()=>({})) as {data?:T;error?:string};if(!response.ok||body.data===undefined){const error=new Error(body.error||fallback) as Error&{status?:number};error.status=response.status;throw error;}return body.data;}

/** Staff read: the booking's partner proof, and the id its proof API is keyed by (the Boarding stay, otherwise the booking). */
export async function loadPartnerProofForReview(service:PartnerProofService,bookingId:string){const config=PARTNER_PROOF_SERVICES[service];let scopeId=bookingId;if(config.scopeKey==="stayId"){const stays=await readJson<Array<{id?:string}>>(await boundedFetch(`/api/boarding-stays?bookingId=${encodeURIComponent(bookingId)}`,{cache:"no-store"}),"Unable to load the Boarding stay");scopeId=String(stays[0]?.id||"");if(!scopeId)return{scopeId:"",media:[] as PartnerProofMedia[]};}const snapshot=await readJson<{media?:PartnerProofMedia[]}>(await boundedFetch(`${config.endpoint}?${config.scopeKey}=${encodeURIComponent(scopeId)}`,{cache:"no-store"}),`Unable to load ${config.title} proof`);return{scopeId,media:snapshot.media??[]};}

/** Staff decision: the service's own governed record_media_scan action. Nothing here approves on anyone's behalf. */
export async function recordPartnerProofDecision(service:PartnerProofService,input:{scopeId:string;mediaId:string;scanResult:"clean"|"rejected";reason:string}){const config=PARTNER_PROOF_SERVICES[service];return readJson<Record<string,unknown>>(await boundedFetch(config.endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({[config.scopeKey]:input.scopeId,action:"record_media_scan",idempotencyKey:`bcc-proof:${input.mediaId}:${crypto.randomUUID()}`,mediaRef:`media://asset/${input.mediaId}`,scanResult:input.scanResult,reason:input.reason})}),"The decision was not recorded");}
