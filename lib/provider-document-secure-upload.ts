type Bucket={put(key:string,value:ArrayBuffer|ReadableStream|Blob|string,options?:Record<string,unknown>):Promise<unknown>;head?(key:string):Promise<{size?:number;httpMetadata?:{contentType?:string}}|null>};
const MAX_BYTES=10*1024*1024;
const ALLOWED_MIME=new Set(["application/pdf","image/jpeg","image/png","image/webp"]);
const text=(v:unknown)=>String(v??"").trim();
const safe=(v:string)=>v.replace(/[^A-Za-z0-9_-]/g,"_").slice(0,80);
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes)).map(b=>b.toString(16).padStart(2,"0")).join("");

function decodeBase64(value:string){const cleaned=value.replace(/^data:[^;]+;base64,/,"");if(!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)||cleaned.length%4!==0)throw new Error("Document payload is not valid base64");const raw=atob(cleaned),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes.buffer;}

export async function storeProviderDocumentSecurely(env:Record<string,unknown>,input:{providerId:string;applicationId:string;documentType:string;mimeType:string;fileBase64:string}){
 const bucket=env.PAWSPACE_MEDIA_BUCKET as Bucket|undefined;
 if(!bucket||typeof bucket.put!=="function")throw new Error("Private PAWSPACE_MEDIA_BUCKET binding is not configured");
 const providerId=text(input.providerId),applicationId=text(input.applicationId),documentType=text(input.documentType),mime=text(input.mimeType).toLowerCase();
 if(!providerId||!applicationId||!documentType)throw new Error("Provider, application and document type are required");
 if(!ALLOWED_MIME.has(mime))throw new Error("Provider document MIME type is not allowed");
 const bytes=decodeBase64(text(input.fileBase64));if(!bytes.byteLength||bytes.byteLength>MAX_BYTES)throw new Error("Provider document exceeds the secure 10 MiB limit");
 const digest=hex(await crypto.subtle.digest("SHA-256",bytes));const ext=mime==="application/pdf"?"pdf":mime==="image/jpeg"?"jpg":mime==="image/png"?"png":"webp";
 const key=`provider-documents/${safe(providerId)}/${safe(applicationId)}/${safe(documentType)}/${digest}.${ext}`;
 await bucket.put(key,bytes,{httpMetadata:{contentType:mime},customMetadata:{classification:"provider_identity_document",providerId:safe(providerId),applicationId:safe(applicationId),documentType:safe(documentType),sha256:digest}});
 if(typeof bucket.head==="function"){const stored=await bucket.head(key);if(!stored||Number(stored.size)!==bytes.byteLength||String(stored.httpMetadata?.contentType||"").toLowerCase()!==mime)throw new Error("Stored provider document verification failed");}
 return{fileRef:`r2://PAWSPACE_MEDIA_BUCKET/${key}`,objectKey:key,sizeBytes:bytes.byteLength,mimeType:mime,sha256:digest,serverOwned:true,privateStorage:true};
}
