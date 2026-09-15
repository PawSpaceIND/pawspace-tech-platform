type Bucket={put(key:string,value:ArrayBuffer|ReadableStream|Blob|string,options?:Record<string,unknown>):Promise<unknown>;head?(key:string):Promise<{size?:number;httpMetadata?:{contentType?:string}}|null>};
const MAX_BYTES=10*1024*1024;
const ALLOWED_MIME=new Set(["application/pdf","image/jpeg","image/png","image/webp"]);
const text=(v:unknown)=>String(v??"").trim();
const safe=(v:string)=>v.replace(/[^A-Za-z0-9_-]/g,"_").slice(0,80);
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes)).map(b=>b.toString(16).padStart(2,"0")).join("");

function decodeBase64(value:string){
 const cleaned=value.replace(/^data:[^;]+;base64,/,"");
 if(!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)||cleaned.length%4!==0)throw new Error("Document payload is not valid base64");
 const raw=atob(cleaned),bytes=new Uint8Array(raw.length);
 for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
 return bytes;
}

/** Detect the real media type from bytes; caller-declared Content-Type is never trusted as evidence. */
export function detectProviderDocumentMime(bytes:Uint8Array):string|null{
 if(bytes.length>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46&&bytes[4]===0x2d)return"application/pdf";
 if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return"image/jpeg";
 if(bytes.length>=8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47&&bytes[4]===0x0d&&bytes[5]===0x0a&&bytes[6]===0x1a&&bytes[7]===0x0a)return"image/png";
 if(bytes.length>=12&&bytes[0]===0x52&&bytes[1]===0x49&&bytes[2]===0x46&&bytes[3]===0x46&&bytes[8]===0x57&&bytes[9]===0x45&&bytes[10]===0x42&&bytes[11]===0x50)return"image/webp";
 return null;
}

/**
 * The private R2 bucket provider identity documents are written to. [R3-B1]
 *
 * Named here, once, for the STAFF surfaces that have to tell an operator what to provision. It is
 * deliberately not part of any message a member of the public can receive: an applicant who tried to
 * upload their Aadhaar was shown "Private PAWSPACE_MEDIA_BUCKET binding is not configured" in a red
 * alert, with HTTP 500, which told them nothing they could act on and told everyone else the name of
 * an internal binding.
 */
export const PROVIDER_DOCUMENT_STORAGE_BINDING="PAWSPACE_MEDIA_BUCKET";
/** What the applicant is told instead. No binding, no vendor, no acronym - just the state and what happens next. */
export const PROVIDER_DOCUMENT_UPLOAD_UNAVAILABLE="Document upload is not available yet on this deployment. Your application stays saved and our team will contact you as soon as we can take your documents.";
/** What an operator is told, on a staff-only surface, so the dead end is actionable rather than mysterious. */
export const PROVIDER_DOCUMENT_STORAGE_OPERATOR_NOTE=`Provision the private R2 bucket and bind it as ${PROVIDER_DOCUMENT_STORAGE_BINDING} (r2_buckets in wrangler config) before caregivers can upload identity documents.`;

/**
 * Whether this deployment can accept a provider document at all.
 *
 * An unprovisioned bucket is a CONFIGURATION state, not a server fault, and it is knowable before a
 * single byte is read - so every caller can refuse early, in words, instead of throwing out of the
 * storage boundary and being reported as a platform outage.
 */
export function providerDocumentStorageConfigured(env:Record<string,unknown>|null|undefined){
 const bucket=(env||{}).PAWSPACE_MEDIA_BUCKET as Bucket|undefined;
 return Boolean(bucket&&typeof bucket.put==="function");
}

export async function storeProviderDocumentSecurely(env:Record<string,unknown>,input:{providerId?:string|null;applicationId:string;documentType:string;mimeType:string;fileBase64:string}){
 const bucket=env.PAWSPACE_MEDIA_BUCKET as Bucket|undefined;
 // Defence in depth behind providerDocumentStorageConfigured(): a caller that forgot to check still
 // must not hand a member of the public the name of an internal binding.
 if(!bucket||typeof bucket.put!=="function")throw new Error(PROVIDER_DOCUMENT_UPLOAD_UNAVAILABLE);
 const applicationId=text(input.applicationId),documentType=text(input.documentType),declaredMime=text(input.mimeType).toLowerCase();
 const providerId=text(input.providerId)||`unassigned-${applicationId}`;
 if(!applicationId||!documentType)throw new Error("Application and document type are required");
 if(!ALLOWED_MIME.has(declaredMime))throw new Error("Provider document MIME type is not allowed");
 const bytes=decodeBase64(text(input.fileBase64));
 if(!bytes.byteLength||bytes.byteLength>MAX_BYTES)throw new Error("Provider document exceeds the secure 10 MiB limit");
 const detectedMime=detectProviderDocumentMime(bytes);
 if(!detectedMime)throw new Error("Provider document content signature is not recognized");
 if(detectedMime!==declaredMime)throw new Error(`Provider document MIME mismatch: declared ${declaredMime}, detected ${detectedMime}`);
 const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
 const digest=hex(await crypto.subtle.digest("SHA-256",buffer));
 const ext=detectedMime==="application/pdf"?"pdf":detectedMime==="image/jpeg"?"jpg":detectedMime==="image/png"?"png":"webp";
 const key=`provider-documents/${safe(providerId)}/${safe(applicationId)}/${safe(documentType)}/${digest}.${ext}`;
 await bucket.put(key,buffer,{httpMetadata:{contentType:detectedMime},customMetadata:{classification:"provider_identity_document",providerId:safe(providerId),applicationId:safe(applicationId),documentType:safe(documentType),sha256:digest,detectedMime}});
 if(typeof bucket.head==="function"){
   const stored=await bucket.head(key);
   if(!stored||Number(stored.size)!==bytes.byteLength||String(stored.httpMetadata?.contentType||"").toLowerCase()!==detectedMime)throw new Error("Stored provider document verification failed");
 }
 return{fileRef:`r2://PAWSPACE_MEDIA_BUCKET/${key}`,objectKey:key,sizeBytes:bytes.byteLength,mimeType:detectedMime,sha256:digest,serverOwned:true,privateStorage:true,magicBytesVerified:true};
}
