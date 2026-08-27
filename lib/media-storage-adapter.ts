/**
 * Private object storage for service media. [PTJA-W3-MS]
 *
 * THE APPROVED RULE, in the business's own words: use a private Cloudflare R2 bucket. No public bucket
 * or permanent public object URL. Short-lived signed upload/download access only. Verify stored object
 * size, media type and ownership against the upload declaration. Credentials as deployment
 * bindings/secrets, never in the repository. Keep adapterConnected:false until an actual environment
 * binding is configured and tested - the adapter and configuration contract may be completed, but
 * operational readiness must not be claimed without the real bucket and credentials.
 *
 * WHAT THIS IS AND IS NOT. It is the contract: the binding name the deployment must provide, and the
 * two operations the boundary is allowed to perform against it. It is NOT a connected bucket. Nothing
 * here creates a Cloudflare resource, writes a wrangler binding, or handles a credential - a worker
 * binding IS the credential, which is the whole point of using one. Until somebody with the account
 * adds the binding, mediaStorageStatus() reports connected:false with the reason, and every media
 * response continues to say adapterConnected:false.
 *
 * WHY NO URL IS EVER BUILT HERE. A permanent object URL is the thing the rule forbids, and the reliable
 * way not to leak one is to have no code capable of composing one: no bucket hostname, no account id,
 * no public base. Reads go out as a short-lived platform grant that lib/media-upload-boundary issues,
 * and the object key never leaves the server.
 */

/** The binding a deployment must provide. Named once, so the error message and the docs cannot drift. */
export const MEDIA_BUCKET_BINDING="PAWSPACE_MEDIA_BUCKET";

/**
 * The narrow slice of an R2 bucket this adapter uses. Deliberately two read operations: the boundary
 * verifies what was stored, it does not need to write, list or delete, and a wider type would invite
 * somebody to use one.
 */
export type MediaObjectStore={
  head(key:string):Promise<{size?:number;httpMetadata?:{contentType?:string}}|null>;
};

export type MediaStorageStatus={
  connected:boolean;
  bucketBinding:string;
  reason:string|null;
  /** Stated so a reader cannot mistake a contract for a deployment. */
  operationallyReady:boolean;
};

async function workerEnv():Promise<Record<string,unknown>>{
  try{
    const{env}=await import("cloudflare:workers");
    return env as unknown as Record<string,unknown>;
  }catch{
    return{};
  }
}

function bindingFrom(env:Record<string,unknown>):MediaObjectStore|null{
  const candidate=env[MEDIA_BUCKET_BINDING];
  if(!candidate||typeof candidate!=="object")return null;
  // A binding that cannot answer "what is stored under this key" is not a binding this adapter can use,
  // and pretending otherwise would produce the exact "unknown treated as verified" outcome the whole
  // audit has been chasing.
  return typeof (candidate as MediaObjectStore).head==="function"?candidate as MediaObjectStore:null;
}

export async function mediaObjectStore():Promise<MediaObjectStore|null>{
  return bindingFrom(await workerEnv());
}

export async function mediaStorageStatus():Promise<MediaStorageStatus>{
  const store=await mediaObjectStore();
  if(!store)return{connected:false,bucketBinding:MEDIA_BUCKET_BINDING,operationallyReady:false,
    reason:`No ${MEDIA_BUCKET_BINDING} binding is configured for this worker. Add a private R2 bucket binding to the deployment; nothing in this repository can supply it.`};
  return{connected:true,bucketBinding:MEDIA_BUCKET_BINDING,operationallyReady:true,reason:null};
}

export type StoredObjectFacts={sizeBytes:number;contentType:string|null};

/**
 * What the bucket says is actually stored under this key, or null if nothing is.
 *
 * Null means NOT PRESENT, and every caller must treat it as a refusal. It must never be collapsed into
 * "could not check, carry on".
 */
export async function headStoredObject(objectKey:string):Promise<StoredObjectFacts|null>{
  const store=await mediaObjectStore();
  if(!store)return null;
  const object=await store.head(objectKey).catch(()=>null);
  if(!object)return null;
  return{sizeBytes:Number(object.size??-1),contentType:object.httpMetadata?.contentType?String(object.httpMetadata.contentType):null};
}
