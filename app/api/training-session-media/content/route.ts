import {ensureTrainingProgrammeTables} from "../../../../lib/training-programme";
import {ensureTrainingSessionLifecycleTables} from "../../../../lib/training-session-lifecycle";
import{authError,database,requireCustomerOwnership,requirePermission,requireProviderOwnership,resolveActor} from "../../../../lib/server-auth";
import{ensureMediaBoundaryTables} from "../../../../lib/media-upload-boundary";
import{readStoredObject} from "../../../../lib/media-storage-adapter";
export async function GET(request:Request){try{
 const id=new URL(request.url).searchParams.get("id")||"";const db=await database();
 const actor=await resolveActor(request);await ensureMediaBoundaryTables(db);await ensureTrainingSessionLifecycleTables(db);await ensureTrainingProgrammeTables(db);
 const row=await db.prepare("SELECT a.*,p.customer_id,s.provider_id AS session_provider_id FROM training_session_media_links l JOIN service_media_assets a ON a.id=l.media_id JOIN training_sessions s ON s.id=l.session_id JOIN training_programmes p ON p.id=s.programme_id WHERE a.id=?").bind(id).first<Record<string,unknown>>();
 if(!row)return Response.json({error:"Training media not found"},{status:404});
 if(actor.subjectType==="customer")await requireCustomerOwnership(db,actor,String(row.customer_id));
 else{requirePermission(actor,"bookings.view");await requireProviderOwnership(db,actor,String(row.session_provider_id));}
 if(row.review_status!=="approved"||row.access_status!=="ready"||row.retention_status!=="active"||Number(row.synthetic)!==0||Number(row.object_stored)!==1)return Response.json({error:"Training media is not released for viewing"},{status:409});
 const object=await readStoredObject(String(row.storage_key));if(!object)return Response.json({error:"Private media storage is unavailable"},{status:503});
 if(object.sizeBytes!==Number(row.size_bytes)||object.contentType!==String(row.mime_type))return Response.json({error:"Stored media does not match its verified registration"},{status:409});
 return new Response(object.body,{headers:{"content-type":String(row.mime_type),"content-length":String(object.sizeBytes),"cache-control":"private, no-store","x-content-type-options":"nosniff","content-disposition":"inline","content-security-policy":"default-src 'none'; sandbox"}});
 }catch(error){return authError(error,"Unable to read Training media");}}
