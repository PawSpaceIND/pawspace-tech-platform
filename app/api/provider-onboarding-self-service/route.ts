import{database}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{addOwnedProviderDocument,addOwnedProviderProfileMedia,acceptOwnedProviderSla,createOwnedProviderApplication,providerOnboardingSelfServiceSnapshot,saveOwnedProviderProfile,scoreOwnedProviderQuiz,submitOwnedProviderApplication,updateOwnedActivatedProfile}from"../../../lib/provider-onboarding-self-service";
import{generateProviderProfileBioDraft}from"../../../lib/provider-profile-ai-bio";
import{storeProviderDocumentSecurely}from"../../../lib/provider-document-secure-upload";
import{acceptProviderAgreementProduction}from"../../../lib/provider-agreement-production-esign";
import{governedClientErrorResponse}from"../../../lib/governed-http-error";

type Body={action?:string;applicationId?:string;payload?:Record<string,unknown>;documentType?:string;fileRef?:string;fileBase64?:string;mimeType?:string;expiresAt?:number|null;quizVersionId?:string;answers?:Record<string,string>;agreementId?:string;mediaType?:"provider_photo"|"home_photo"|"facility_photo"|"business_photo"|"reference";changes?:Record<string,unknown>;reason?:string;verticalKey?:string;cityCode?:string;displayName?:string;businessName?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin provider onboarding write blocked",{status:403});}
async function providerActor(request:Request){const db=await database(),actor=await resolvePlatformSession(db,request);if(!actor)throw new Response("Provider identity session required",{status:401});if(actor.subjectType!=="provider"||actor.roleCode!=="service_provider")throw new Response("Provider identity required",{status:403});return{db,actor};}
async function runtimeEnv(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
async function audit(db:D1Database,actor:{auditId:string;roleCode:string},action:string,resourceId:string|null,outcome:string,detail:unknown={}){await db.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),actor.auditId,actor.roleCode,action,"provider_onboarding_self_service",resourceId,outcome,JSON.stringify(detail),Date.now()).run();}
/*
 * A thrown Response carried the right status and then lost its message to a generic string, while a
 * thrown Error kept its message and became a 500. Neither path could produce "correct status AND
 * something the applicant can act on", which is why a missing onboarding policy reached a caregiver
 * as a 500 carrying raw JSON.
 */
async function failure(error:unknown){
 if(error instanceof Response){const message=await error.text().catch(()=>"");return json({error:message||"Provider onboarding request rejected"},error.status);}
 /* A branded business-rule refusal carries BOTH its reason and its 4xx status. Without this bridge an
  * applicant who tried to submit before uploading their ID was told, with status 500, that the
  * platform had failed - the one reading of it they could do nothing about. [W2-F] */
 const governed=governedClientErrorResponse(error);
 if(governed)return governed;
 return json({error:error instanceof Error?error.message:"Unable to update provider onboarding"},500);
}

/*
 * Which acceptance the applicant's screen must post. [W2-F]
 *
 * `accept_sla_uat` is refused with a 409 in production and `accept_sla` (the real e-sign) is refused
 * everywhere its ECDSA key material is absent - and nothing told the screen which one it was looking
 * at, so /partner/onboarding hard-coded the UAT action and a production applicant could not accept
 * their agreement at all. Reported as capability, never as key material.
 */
function agreementAcceptanceMode(env:Record<string,unknown>){
 const production=String(env.DEPLOYMENT_PROFILE||env.PAWSPACE_DEPLOYMENT_ENV).toLowerCase()==="production";
 const signingConfigured=Boolean(String(env.PROVIDER_AGREEMENT_ESIGN_PRIVATE_KEY_PKCS8_B64||"").trim()&&String(env.PROVIDER_AGREEMENT_ESIGN_PUBLIC_KEY_SPKI_B64||"").trim()&&String(env.PROVIDER_AGREEMENT_ESIGN_KEY_ID||"").trim());
 return{mode:production||signingConfigured?"production":"uat",action:production||signingConfigured?"accept_sla":"accept_sla_uat",available:production?signingConfigured:true};
}

export async function GET(request:Request){try{const{db,actor}=await providerActor(request);const data=await providerOnboardingSelfServiceSnapshot(db,actor.subjectId);await audit(db,actor,"provider.onboarding.self_service.read",null,"allowed");return json({data:{...data,agreementAcceptance:agreementAcceptanceMode(await runtimeEnv())}});}catch(error){return await failure(error);}}

export async function POST(request:Request){let db:D1Database|undefined,actor:Awaited<ReturnType<typeof resolvePlatformSession>>=null,action="unknown",resourceId:string|null=null;try{sameOrigin(request);const resolved=await providerActor(request);db=resolved.db;actor=resolved.actor;const body=await request.json() as Body;action=String(body.action||"");let data:unknown,status=200;
 if(action==="create_application"){if(!body.payload)return json({error:"Application payload is required"},400);data=await createOwnedProviderApplication(db,{providerId:actor.subjectId,actorId:actor.auditId,payload:body.payload});resourceId=(data as{ id:string}).id;status=201;}
 else if(action==="upload_document"){if(!body.applicationId||!body.documentType||!body.fileBase64||!body.mimeType)return json({error:"Application, document type, MIME type and document payload are required"},400);resourceId=body.applicationId;await (await import("../../../lib/provider-onboarding-self-service")).ensureProviderOwnsOnboardingApplication(db,actor.subjectId,body.applicationId);const stored=await storeProviderDocumentSecurely(await runtimeEnv(),{providerId:actor.subjectId,applicationId:body.applicationId,documentType:body.documentType,mimeType:body.mimeType,fileBase64:body.fileBase64});const record=await addOwnedProviderDocument(db,{providerId:actor.subjectId,actorId:actor.auditId,applicationId:body.applicationId,documentType:body.documentType,fileRef:stored.fileRef,expiresAt:body.expiresAt});data={record,storage:{sha256:stored.sha256,sizeBytes:stored.sizeBytes,mimeType:stored.mimeType,serverOwned:true,privateStorage:true}};status=201;}
 else if(action==="add_document"){const env=await runtimeEnv();if(String(env.DEPLOYMENT_PROFILE||env.PAWSPACE_DEPLOYMENT_ENV).toLowerCase()==="production")return json({error:"Client-supplied document references are disabled in production; use upload_document"},409);if(!body.applicationId||!body.documentType||!body.fileRef)return json({error:"Application, document type and secure file reference are required"},400);resourceId=body.applicationId;data=await addOwnedProviderDocument(db,{providerId:actor.subjectId,actorId:actor.auditId,applicationId:body.applicationId,documentType:body.documentType,fileRef:body.fileRef,expiresAt:body.expiresAt});status=201;}
 else if(action==="submit_application"){if(!body.applicationId)return json({error:"Application ID is required"},400);resourceId=body.applicationId;data=await submitOwnedProviderApplication(db,{providerId:actor.subjectId,actorId:actor.auditId,applicationId:body.applicationId});}
 else if(action==="score_quiz"){if(!body.applicationId||!body.quizVersionId||!body.answers)return json({error:"Application, frozen quiz version and answers are required"},400);resourceId=body.applicationId;data=await scoreOwnedProviderQuiz(db,{providerId:actor.subjectId,applicationId:body.applicationId,quizVersionId:body.quizVersionId,answers:body.answers});status=201;}
 else if(action==="accept_sla"){if(!body.applicationId||!body.agreementId)return json({error:"Application and agreement IDs are required"},400);resourceId=body.applicationId;data=await acceptProviderAgreementProduction(db,await runtimeEnv(),{agreementId:body.agreementId,providerId:actor.subjectId,actorId:actor.auditId});}
 else if(action==="accept_sla_uat"){const env=await runtimeEnv();if(String(env.DEPLOYMENT_PROFILE||env.PAWSPACE_DEPLOYMENT_ENV).toLowerCase()==="production")return json({error:"UAT agreement acceptance is disabled in production"},409);if(!body.applicationId||!body.agreementId)return json({error:"Application and agreement IDs are required"},400);resourceId=body.applicationId;data=await acceptOwnedProviderSla(db,{providerId:actor.subjectId,actorId:actor.auditId,applicationId:body.applicationId,agreementId:body.agreementId});}
 else if(action==="save_profile"){if(!body.applicationId||!body.payload)return json({error:"Application ID and profile payload are required"},400);resourceId=body.applicationId;data=await saveOwnedProviderProfile(db,{providerId:actor.subjectId,actorId:actor.auditId,applicationId:body.applicationId,payload:body.payload});}
 else if(action==="generate_profile_bio_ai"){if(!body.verticalKey)return json({error:"Vertical key is required"},400);const draft=await generateProviderProfileBioDraft({verticalKey:body.verticalKey,cityCode:body.cityCode,displayName:body.displayName,businessName:body.businessName});if(!draft.connected)return json({error:draft.reason,connected:false},503);data={bio:draft.bio,modelRef:draft.modelRef,providerRef:draft.providerRef,draftOnly:true};}
 else if(action==="add_profile_media"){
   /* An applicant has no way to obtain a secure file reference, and must not be believed if they
    * produce one - the same reason `add_document` is disabled in production. Bytes go through the
    * secure storage boundary here and the reference the SERVER gets back is what is recorded, so a
    * partner can add their own photo without the route ever trusting a client-supplied ref. [W2-F] */
   if(!body.applicationId||!body.mediaType)return json({error:"Application and media type are required"},400);
   resourceId=body.applicationId;
   let mediaRef=String(body.fileRef||"").trim();
   if(body.fileBase64&&body.mimeType){
     await (await import("../../../lib/provider-onboarding-self-service")).ensureProviderOwnsOnboardingApplication(db,actor.subjectId,body.applicationId);
     const stored=await storeProviderDocumentSecurely(await runtimeEnv(),{providerId:actor.subjectId,applicationId:body.applicationId,documentType:`profile_media_${body.mediaType}`,mimeType:body.mimeType,fileBase64:body.fileBase64});
     mediaRef=stored.fileRef;
   }else{
     const env=await runtimeEnv();
     if(String(env.DEPLOYMENT_PROFILE||env.PAWSPACE_DEPLOYMENT_ENV).toLowerCase()==="production")return json({error:"Client-supplied media references are disabled in production; upload the photo itself"},409);
   }
   if(!mediaRef)return json({error:"Upload the photo itself, or supply a secure file reference"},400);
   data=await addOwnedProviderProfileMedia(db,{providerId:actor.subjectId,actorId:actor.auditId,applicationId:body.applicationId,mediaType:body.mediaType,fileRef:mediaRef});status=201;
 }
 else if(action==="update_activated_profile"){if(!body.applicationId||!body.changes||!body.reason)return json({error:"Application, changes and reason are required"},400);resourceId=body.applicationId;data=await updateOwnedActivatedProfile(db,{providerId:actor.subjectId,actorId:actor.auditId,applicationId:body.applicationId,changes:body.changes,reason:body.reason});}
 else return json({error:"Unsupported provider self-service action"},400);
 await audit(db,actor,`provider.onboarding.self_service.${action}`,resourceId,"completed",{serverOwnedDocumentUpload:action==="upload_document",productionEsign:action==="accept_sla"});return json({data},status);
 }catch(error){if(db&&actor)await audit(db,actor,`provider.onboarding.self_service.${action}`,resourceId,"denied",{status:error instanceof Response?error.status:Number((error as{statusCode?:unknown})?.statusCode)||500}).catch(()=>{});return await failure(error);}}
