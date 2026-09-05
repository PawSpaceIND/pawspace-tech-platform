import{ensureProviderOnboardingHumanActivation}from"./provider-onboarding-human-activation";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const b64bytes=(value:string)=>{const raw=atob(value.replace(/\s+/g,""));const out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out.buffer;};
const bytesB64=(value:ArrayBuffer)=>{let raw="";for(const byte of new Uint8Array(value))raw+=String.fromCharCode(byte);return btoa(raw);};
const hex=(value:ArrayBuffer)=>Array.from(new Uint8Array(value)).map(b=>b.toString(16).padStart(2,"0")).join("");

async function signingKeys(env:Record<string,unknown>){
 const privateKeyB64=text(env.PROVIDER_AGREEMENT_ESIGN_PRIVATE_KEY_PKCS8_B64),publicKeyB64=text(env.PROVIDER_AGREEMENT_ESIGN_PUBLIC_KEY_SPKI_B64),keyId=text(env.PROVIDER_AGREEMENT_ESIGN_KEY_ID);
 if(!privateKeyB64||!publicKeyB64||!keyId)throw new Error("Production provider-agreement signing key material is not configured");
 const algorithm={name:"ECDSA",namedCurve:"P-256"} as EcKeyImportParams;
 const privateKey=await crypto.subtle.importKey("pkcs8",b64bytes(privateKeyB64),algorithm,false,["sign"]);
 const publicKey=await crypto.subtle.importKey("spki",b64bytes(publicKeyB64),algorithm,false,["verify"]);
 return{privateKey,publicKey,keyId};
}

export async function acceptProviderAgreementProduction(db:D1Database,env:Record<string,unknown>,input:{agreementId:string;providerId:string;actorId:string}){
 await ensureProviderOnboardingHumanActivation(db);
 const row=await db.prepare("SELECT a.*,c.content_text FROM provider_onboarding_agreements a JOIN provider_onboarding_content_versions c ON c.id=a.content_id WHERE a.id=?").bind(input.agreementId).first<Row>();
 if(!row||text(row.status)!=="awaiting_acceptance")throw new Error("SLA is not awaiting acceptance");
 const applicationId=text(row.application_id),providerId=text(input.providerId),application=await db.prepare("SELECT provider_id,human_decision,status FROM provider_onboarding_applications WHERE id=?").bind(applicationId).first<Row>();
 if(!application||text(application.provider_id)!==providerId)throw new Response("Provider agreement ownership denied",{status:403});
 if(text(application.human_decision)!=="approved")throw new Error("Human approval is required before SLA acceptance");
 const now=Date.now(),payload={agreementId:input.agreementId,applicationId,providerId,agreementVersion:Number(row.agreement_version),contentId:text(row.content_id),contentVersion:Number(row.content_version),contentSha256:hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text(row.content_text)))),acceptedAt:now};
 const canonical=JSON.stringify(payload),keys=await signingKeys(env),signature=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,new TextEncoder().encode(canonical));
 const verified=await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},keys.publicKey,signature,new TextEncoder().encode(canonical));if(!verified)throw new Error("Provider agreement cryptographic verification failed");
 const acceptanceRef=`ESIGN-${keys.keyId}-${hex(await crypto.subtle.digest("SHA-256",signature)).slice(0,24)}`;
 await db.prepare("CREATE TABLE IF NOT EXISTS provider_agreement_signatures (agreement_id TEXT PRIMARY KEY,application_id TEXT NOT NULL,provider_id TEXT NOT NULL,key_id TEXT NOT NULL,algorithm TEXT NOT NULL,payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,signature_b64 TEXT NOT NULL,verified INTEGER NOT NULL,created_at INTEGER NOT NULL)").run();
 const payloadHash=hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical)));
 await db.batch([db.prepare("INSERT INTO provider_agreement_signatures (agreement_id,application_id,provider_id,key_id,algorithm,payload_json,payload_sha256,signature_b64,verified,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)").bind(input.agreementId,applicationId,providerId,keys.keyId,"ECDSA_P256_SHA256",canonical,payloadHash,bytesB64(signature),now),db.prepare("UPDATE provider_onboarding_agreements SET esign_adapter='webcrypto_ecdsa_p256',environment='production',external_connected=1,status='accepted',accepted_by=?,accepted_at=?,acceptance_ref=?,updated_at=? WHERE id=? AND status='awaiting_acceptance'").bind(providerId,now,acceptanceRef,now,input.agreementId),db.prepare("UPDATE provider_onboarding_applications SET status='profile',updated_at=? WHERE id=?").bind(now,applicationId),db.prepare("INSERT INTO provider_onboarding_events (id,application_id,event_type,from_status,to_status,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),applicationId,"sla_production_esign_verified",text(application.status),"profile",input.actorId,JSON.stringify({agreementId:input.agreementId,keyId:keys.keyId,algorithm:"ECDSA_P256_SHA256",payloadSha256:payloadHash,acceptanceRef}),now)]);
 return{id:input.agreementId,status:"accepted",acceptanceRef,keyId:keys.keyId,algorithm:"ECDSA_P256_SHA256",verified:true,liveEsignExecuted:true};
}
