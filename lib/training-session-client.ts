import {boundedFetch} from "./bounded-fetch";
import {getDeviceLocation} from "./device-location-client";
export type TrainerSession={id:string;programme_id:string;booking_id:string;sequence_no:number;provider_id:string;scheduled_start:string;scheduled_end:string;status:string;customer_id:string;customer_name:string;plan_code:string;plan_name:string;total_sessions:number;completed_sessions:number;no_show_sessions:number;cancelled_sessions:number;programme_status:string;petIds:string[];requirements:string[];attendance:Record<string,unknown>;homework:Record<string,unknown>;progress:Record<string,unknown>;evidenceRefs:string[];ownerHandover?:{durationMinutes:number;completedAt:number}|null;events:Array<Record<string,unknown>>};
export type TrainingReport={attendance:Record<string,unknown>;homework:string;progress:Record<string,number>;evidenceRefs:string[]};

async function body<T>(response:Response){const result=await response.json() as {data?:T;error?:string};if(!response.ok)throw new Error(result.error||`Training request failed (${response.status})`);return result.data as T;}
export async function currentProviderIdentity(){const response=await boundedFetch("/api/identity-session",{cache:"no-store",credentials:"include"});return body<{subjectType:"customer"|"provider";subjectId:string;roleCode:string;expiresAt:number}>(response);}
export async function loadTrainerSessions(providerId:string){const response=await boundedFetch(`/api/training-sessions?providerId=${encodeURIComponent(providerId)}`,{cache:"no-store",credentials:"include"});return body<TrainerSession[]>(response);}
export async function trainingSessionAction(input:{sessionId:string;action:string;reason?:string;report?:TrainingReport;newStart?:string;newEnd?:string;newProviderId?:string;ownerHandoverMinutes?:number}){const location=input.action==="arrive"?await getDeviceLocation():{};const response=await boundedFetch("/api/training-sessions",{method:"POST",headers:{"content-type":"application/json"},credentials:"include",body:JSON.stringify({...input,...location,idempotencyKey:`training:${input.sessionId}:${input.action}:${crypto.randomUUID()}`})});return body<Record<string,unknown>>(response);}
export type TrainingEvidencePurpose="before_service"|"after_service"|"training_homework";
export type TrainingEvidenceAsset={id:string;ref:string;purpose:TrainingEvidencePurpose;proofReady:boolean;scan_status:string;access_status:string;review_status?:string;retention_status?:string};
type EvidenceGrant={id:string;ref:string;proofReady:boolean;duplicatePrevented?:boolean;upload?:{token:string;objectKey:string}};
export async function prepareTrainingEvidence(input:{sessionId:string;file:File;purpose?:TrainingEvidencePurpose}){
 const bytes=await input.file.arrayBuffer(),digest=await crypto.subtle.digest("SHA-256",bytes),sha256=Array.from(new Uint8Array(digest)).map(value=>value.toString(16).padStart(2,"0")).join("");
 const response=await boundedFetch("/api/training-session-media",{method:"POST",headers:{"content-type":"application/json"},credentials:"include",body:JSON.stringify({sessionId:input.sessionId,purpose:input.purpose??"training_homework",retryUpload:true,mimeType:input.file.type,sizeBytes:input.file.size,sha256,fileName:input.file.name})});
 const prepared=await body<EvidenceGrant>(response);
 if(prepared.duplicatePrevented&&!prepared.upload)return {...prepared,alreadyUploaded:true,objectStored:null};
 if(!prepared.upload?.token)throw new Error("Evidence registration did not return an upload grant. Please select the photo again.");
 const uploaded=await boundedFetch("/api/service-media/upload",{method:"PUT",headers:{"content-type":input.file.type,"x-pawspace-media-id":prepared.id,"x-pawspace-upload-token":prepared.upload.token},credentials:"include",body:input.file},60_000);
 const result=await body<{objectStored:boolean;adapterConnected:boolean;proofReady:boolean}>(uploaded);
 return {...prepared,proofReady:result.proofReady,alreadyUploaded:false,objectStored:result.objectStored};
}
export async function loadTrainingEvidence(sessionId:string){const response=await boundedFetch(`/api/training-session-media?sessionId=${encodeURIComponent(sessionId)}`,{cache:"no-store",credentials:"include"});return body<{sessionId:string;assets:TrainingEvidenceAsset[]}>(response);}
