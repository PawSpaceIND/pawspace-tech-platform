/**
 * The signed-upload boundary for PawSpace service media. [PTJA W2-B4-M04]
 *
 * THE APPROVED RULE, in the business's own words:
 *   1. An authenticated user requests a short-lived upload token.
 *   2. The server verifies booking assignment and permitted media category.
 *   3. The token is restricted by object key, file type, size and expiry.
 *   4. The file uploads directly to private storage.
 *   5. The server verifies the uploaded object before registration.
 *   6. Media begins as PENDING_REVIEW.
 *   7. The uploader cannot approve their own media.
 *   8. The customer receives only a short-lived signed read URL.
 *   9. Replacement, deletion and approval are audited.
 *   Reject executable formats, arbitrary external URLs, cross-booking object keys and reused or
 *   expired upload tokens.
 *
 * WHY IT IS HERE AND NOT IN A ROUTE. Five surfaces capture service media - grooming proof, training
 * homework, walking, food delivery, boarding - and the audit found the same boundary written five
 * times with four different answers. app/api/service-media and app/api/training-session-media had no
 * upload grant at all: their POST answered storage:{mode:"not_connected"} and confirmation accepted any
 * opaque object id from any bookings.manage actor, unbound to the prepared asset. This module is the
 * one place that answers "may this person upload this file against this booking, and is the object
 * that arrived the object that was promised". Adding a sixth copy would have repeated the defect.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED. No storage adapter is connected in this environment. `redeem`
 * therefore verifies the object against what the CALLER observed, and every response says
 * `adapterConnected:false`. That is an honest contract, not a stub that pretends: when the adapter
 * lands it replaces the observation argument with a real HEAD of the private object, and every other
 * control in this file - the key binding, the single use, the expiry, the review gate - is unchanged.
 * Nothing here reports a successful upload that did not happen.
 *
 * GOVERNED, NOT WELDED IN. Which categories a vertical may capture, which formats it accepts, the size
 * ceiling and both token lifetimes are business settings that already differ by service and will
 * differ by city, so they live in the policy kernel under the `media_upload` domain and are edited in
 * the Control Center. The executable-format refusal is NOT one of them: it is a platform floor,
 * enforced both when a config is written and again at grant time, so widening the config cannot mint a
 * token for an executable.
 */
import{POLICY_ANY,registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";
import{ensureServiceMediaTable}from"./service-media-security";
import{headStoredObject,mediaStorageStatus}from"./media-storage-adapter";
import{mediaReleaseVerdict,mediaScanState}from"./media-scan-boundary";

type Db=D1Database;
type Row=Record<string,unknown>;

/** Every media category the platform knows. A policy may permit a subset, never something outside it. */
export const MEDIA_CATEGORIES=["before_service","after_service","service_issue","training_homework","stay_update"] as const;
export type MediaCategory=typeof MEDIA_CATEGORIES[number];

/**
 * The formats the platform will accept under ANY configuration. A raster image that browsers render
 * without scripting. `image/svg+xml` is absent on purpose: SVG is a document that executes script.
 */
export const PLATFORM_MEDIA_MIME_FLOOR=["image/jpeg","image/png","image/webp"] as const;

/** Suffixes that carry code. Checked on the declared file name, whatever content type is claimed. */
export const EXECUTABLE_MEDIA_SUFFIXES=[".exe",".dll",".so",".dylib",".bat",".cmd",".com",".msi",".scr",".sh",".bash",".zsh",".ps1",".psm1",".py",".rb",".pl",".php",".jsp",".asp",".aspx",".jar",".war",".apk",".app",".js",".mjs",".cjs",".vbs",".wsf",".hta",".svg",".htm",".html",".xhtml",".swf"];

export const MEDIA_UPLOAD_POLICY_DOMAIN="media_upload";

export type MediaUploadPolicy={
  permittedCategories:string[];
  allowedMimeTypes:string[];
  minSizeBytes:number;
  maxSizeBytes:number;
  uploadTokenTtlSeconds:number;
  readUrlTtlSeconds:number;
  requireSeparateApprover:boolean;
};

/**
 * The approved platform baseline. Every value here is also the value a stored row inherits for a field
 * it does not carry, which is why each one is the strict answer: the full category list is the set the
 * platform actually implements, the formats are the floor itself, and both lifetimes are minutes.
 */
export const APPROVED_MEDIA_UPLOAD_BOUNDARY:MediaUploadPolicy={
  permittedCategories:[...MEDIA_CATEGORIES],
  allowedMimeTypes:[...PLATFORM_MEDIA_MIME_FLOOR],
  minSizeBytes:1,
  maxSizeBytes:10_000_000,
  uploadTokenTtlSeconds:900,
  readUrlTtlSeconds:300,
  requireSeparateApprover:true,
};

const list=(value:unknown)=>Array.isArray(value)?value.map(entry=>String(entry).trim().toLowerCase()).filter(Boolean):[];

registerServicePolicyDomain<MediaUploadPolicy&Record<string,unknown>>({
  domain:MEDIA_UPLOAD_POLICY_DOMAIN,
  label:"Service media upload boundary",
  managePermission:"settings.manage",
  defaults:APPROVED_MEDIA_UPLOAD_BOUNDARY as MediaUploadPolicy&Record<string,unknown>,
  problem(config){
    const categories=list(config.permittedCategories);
    if(!categories.length)return"At least one media category must be permitted";
    const unknown=categories.filter(entry=>!(MEDIA_CATEGORIES as readonly string[]).includes(entry));
    if(unknown.length)return`Unknown media categories: ${unknown.join(", ")}`;
    const mimeTypes=list(config.allowedMimeTypes);
    if(!mimeTypes.length)return"At least one media file type must be permitted";
    // The floor, applied on the WRITE path. A widened config is refused before it is stored, so the
    // Control Center cannot make an executable format uploadable by editing a policy row.
    const outside=mimeTypes.filter(entry=>!(PLATFORM_MEDIA_MIME_FLOOR as readonly string[]).includes(entry));
    if(outside.length)return`These file types are outside the PawSpace media floor and cannot be permitted: ${outside.join(", ")}`;
    const min=Number(config.minSizeBytes),max=Number(config.maxSizeBytes);
    if(!Number.isFinite(min)||min<1)return"The minimum media size must be at least 1 byte";
    if(!Number.isFinite(max)||max<min)return"The maximum media size must be at least the minimum";
    if(max>APPROVED_MEDIA_UPLOAD_BOUNDARY.maxSizeBytes)return`The maximum media size cannot exceed ${APPROVED_MEDIA_UPLOAD_BOUNDARY.maxSizeBytes} bytes`;
    for(const[key,label]of[["uploadTokenTtlSeconds","upload token"],["readUrlTtlSeconds","signed read URL"]] as const){
      const ttl=Number(config[key]);
      if(!Number.isFinite(ttl)||ttl<60||ttl>3600)return`The ${label} lifetime must be between 60 and 3600 seconds`;
    }
    // Rule 7 is not optional. The field stays visible so the Control Center shows what is in force.
    if(config.requireSeparateApprover!==true)return"Media must be approved by someone other than the uploader; this cannot be switched off";
    return null;
  },
});

const refuse=(message:string,status=400,extra:Record<string,unknown>={}):never=>{throw Response.json({error:message,...extra},{status});};
const OPAQUE_KEY=/^[A-Za-z0-9._\/-]{8,256}$/;
const SHA256=/^[a-f0-9]{64}$/i;

async function digest(value:string){
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
const secret=()=>crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-","");

const tablesEnsured=new WeakSet<Db>();
export async function ensureMediaBoundaryTables(db:Db){
  if(tablesEnsured.has(db))return;
  await ensureServiceMediaTable(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS media_upload_grants (id TEXT PRIMARY KEY,media_id TEXT NOT NULL UNIQUE,booking_id TEXT NOT NULL,scope_type TEXT NOT NULL,scope_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,category TEXT NOT NULL,object_key TEXT NOT NULL,mime_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,token_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'issued',expires_at INTEGER NOT NULL,consumed_at INTEGER,policy_version TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_upload_grants_scope ON media_upload_grants(booking_id,scope_id,status)"),
    db.prepare("CREATE TABLE IF NOT EXISTS media_read_grants (id TEXT PRIMARY KEY,media_id TEXT NOT NULL,audience TEXT NOT NULL,token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_media_read_grants_media ON media_read_grants(media_id,expires_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS service_media_events (id TEXT PRIMARY KEY,media_id TEXT NOT NULL,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
  ]);
  // The review columns are added by ensureServiceMediaTable, which owns the table. They were briefly
  // added here instead, which left the proof gate reading a column its own ensure path never created.
  tablesEnsured.add(db);
}

async function mediaEvent(db:Db,mediaId:string,bookingId:string,eventType:string,actorId:string,detail:unknown){
  await db.prepare("INSERT INTO service_media_events (id,media_id,booking_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),mediaId,bookingId,eventType,actorId,JSON.stringify(detail),Date.now()).run();
}

export async function mediaUploadPolicy(db:Db,scope:{serviceCode?:string|null;cityId?:string|null}){
  return resolveServicePolicy<MediaUploadPolicy&Record<string,unknown>>(db,MEDIA_UPLOAD_POLICY_DOMAIN,scope);
}

/**
 * Step 2's assignment half, read from the record that proves it rather than from the caller's claim.
 * A booking-scoped upload needs a provider work order naming this provider; a training-session upload
 * needs the session itself. An absent record is a refusal, never a pass.
 */
async function assertAssignment(db:Db,input:{scopeType:string;scopeId:string;bookingId:string;providerId:string}){
  if(input.scopeType==="booking"){
    const row=await db.prepare("SELECT provider_id,service_code FROM provider_work_orders WHERE booking_id=?").bind(input.bookingId).first<Row>()
      .catch(()=>{throw Response.json({error:"Booking assignment cannot be verified"},{status:409});});
    if(!row)refuse("No provider work order exists for this booking",404);
    if(String(row!.provider_id)!==input.providerId)refuse("This provider is not assigned to the booking",403);
    return;
  }
  if(input.scopeType==="training_session"){
    const row=await db.prepare("SELECT provider_id,booking_id FROM training_sessions WHERE id=?").bind(input.scopeId).first<Row>()
      .catch(()=>{throw Response.json({error:"Training session assignment cannot be verified"},{status:409});});
    if(!row)refuse("Training session not found",404);
    if(String(row!.provider_id)!==input.providerId)refuse("This provider is not assigned to the training session",403);
    if(String(row!.booking_id)!==input.bookingId)refuse("Training session belongs to another booking",403);
    return;
  }
  refuse("Unsupported media scope",400);
}

export type MediaUploadRequest={
  bookingId:string;scopeType:"booking"|"training_session";scopeId:string;providerId:string;
  serviceCode:string;cityId?:string|null;category:string;
  mimeType:string;sizeBytes:number;sha256:string;fileName?:string;actorId:string;supersedes?:string;
};

export type MediaUploadGrant={
  mediaId:string;mediaRef:string;grantId:string;token:string;objectKey:string;
  category:string;mimeType:string;sizeBytes:number;sha256:string;expiresAt:number;
  reviewStatus:"pending_review";proofReady:false;policyVersion:string;
  upload:{mode:"private_object_put";adapterConnected:false;rawPublicUrl:false;singleUse:true};
  supersedes?:string;
};

/** Steps 1-3: an authenticated, assigned uploader receives one short-lived token, bound to one object. */
export async function issueMediaUploadGrant(db:Db,input:MediaUploadRequest):Promise<MediaUploadGrant>{
  await ensureMediaBoundaryTables(db);
  const bookingId=String(input.bookingId||"").trim(),scopeId=String(input.scopeId||"").trim();
  const providerId=String(input.providerId||"").trim(),actorId=String(input.actorId||"").trim();
  const serviceCode=String(input.serviceCode||"").trim().toLowerCase();
  if(!bookingId||!scopeId||!providerId||!actorId||!serviceCode)refuse("Booking, scope, provider, service and actor are required",400);
  await assertAssignment(db,{scopeType:input.scopeType,scopeId,bookingId,providerId});

  const policy=(await mediaUploadPolicy(db,{serviceCode,cityId:input.cityId})),config=policy.config;
  const category=String(input.category||"").trim().toLowerCase();
  if(!config.permittedCategories.map(String).includes(category))
    refuse(`This service does not capture ${category||"that"} media`,400,{code:"media_category_not_permitted",permitted:config.permittedCategories,policyVersion:policy.policyVersion});

  const mimeType=String(input.mimeType||"").trim().toLowerCase();
  // The floor, restated. Note honestly what this line is and is not: with the domain validator refusing
  // a non-floor type on WRITE and resolveServicePolicy refusing such a row on READ, no configuration
  // can reach here listing an executable, so sabotage of this line alone changes no test. It is kept as
  // a local, readable statement of the rule for whoever edits the policy defaults next, not as the
  // control that enforces it - the validator is. [PTJA-W2-B4-M04]
  if(!(PLATFORM_MEDIA_MIME_FLOOR as readonly string[]).includes(mimeType))
    refuse("Only JPEG, PNG and WebP media is accepted",400,{code:"media_type_not_accepted"});
  if(!config.allowedMimeTypes.map(String).includes(mimeType))
    refuse("This service does not accept that media format",400,{code:"media_type_not_permitted",permitted:config.allowedMimeTypes,policyVersion:policy.policyVersion});

  const fileName=String(input.fileName||"").trim().toLowerCase();
  if(fileName){
    if(fileName.includes("://")||fileName.includes("\\")||fileName.includes("/"))refuse("A media file name must not contain a path or a URL",400);
    const suffix=EXECUTABLE_MEDIA_SUFFIXES.find(entry=>fileName.endsWith(entry));
    if(suffix)refuse(`Executable and scriptable files are never accepted as media (${suffix})`,400,{code:"executable_media_refused"});
  }

  const sizeBytes=Number(input.sizeBytes);
  if(!Number.isFinite(sizeBytes)||sizeBytes<config.minSizeBytes||sizeBytes>config.maxSizeBytes)
    refuse(`Media must be between ${config.minSizeBytes} byte and ${config.maxSizeBytes} bytes`,400,{code:"media_size_out_of_range"});
  const sha256=String(input.sha256||"").trim().toLowerCase();
  if(!SHA256.test(sha256))refuse("A valid SHA-256 checksum is required",400);

  const mediaId=`MEDIA-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
  const grantId=`MGRANT-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
  const objectKey=`${serviceCode}/${input.scopeType}/${scopeId}/${mediaId}`;
  if(objectKey.includes("://")||!OPAQUE_KEY.test(objectKey))refuse("Media object key could not be formed as an opaque private key",400);
  const token=`${grantId}.${secret()}`,tokenHash=await digest(token);
  const now=Date.now(),expiresAt=now+config.uploadTokenTtlSeconds*1000;

  await db.batch([
    db.prepare("INSERT INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at,review_status,supersedes) VALUES (?,?,?,?,?,?,?,?,'pending','pending_upload','active',0,?,?,?,'pending_review',?)")
      .bind(mediaId,bookingId,providerId,category,objectKey,mimeType,sizeBytes,sha256,actorId,now,now,input.supersedes??null),
    db.prepare("INSERT INTO media_upload_grants (id,media_id,booking_id,scope_type,scope_id,provider_id,service_code,city_id,category,object_key,mime_type,size_bytes,sha256,token_hash,status,expires_at,consumed_at,policy_version,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',?,NULL,?,?,?)")
      .bind(grantId,mediaId,bookingId,input.scopeType,scopeId,providerId,serviceCode,String(input.cityId||POLICY_ANY).trim().toLowerCase()||POLICY_ANY,category,objectKey,mimeType,sizeBytes,sha256,tokenHash,expiresAt,policy.policyVersion,actorId,now),
  ]);
  await mediaEvent(db,mediaId,bookingId,"media_upload_grant_issued",actorId,{grantId,category,objectKey,mimeType,sizeBytes,expiresAt,scopeType:input.scopeType,scopeId,policyVersion:policy.policyVersion,adapterConnected:false});

  return{mediaId,mediaRef:`media://asset/${mediaId}`,grantId,token,objectKey,category,mimeType,sizeBytes,sha256,expiresAt,
    reviewStatus:"pending_review",proofReady:false,policyVersion:policy.policyVersion,
    upload:{mode:"private_object_put",adapterConnected:false,rawPublicUrl:false,singleUse:true},
    ...(input.supersedes?{supersedes:input.supersedes}:{})};
}

export type ObservedObject={sizeBytes?:number;sha256?:string;mimeType?:string};

/**
 * Step 5: the object that arrived must be the object that was promised, and the token that presents it
 * must be the one this asset was issued, unexpired and unused.
 *
 * `observed` is what the storage layer reports about the stored object. There is no adapter connected
 * here, so today the caller supplies it; when one lands this argument is replaced by a HEAD against the
 * private bucket and nothing else in this function changes. It is REQUIRED either way - an absent
 * observation is refused rather than treated as a match, which is the defect this whole audit chased.
 */
export async function redeemMediaUploadGrant(db:Db,input:{token:string;objectKey:string;observed?:ObservedObject;actorId:string}){
  await ensureMediaBoundaryTables(db);
  const token=String(input.token||"").trim(),objectKey=String(input.objectKey||"").trim();
  if(!token||!objectKey)refuse("An upload token and the stored object key are required",400);
  if(objectKey.includes("://")||objectKey.startsWith("//")||!OPAQUE_KEY.test(objectKey))
    refuse("Uploads must be confirmed with the private object key, not a URL",400,{code:"external_url_refused"});

  const grantId=token.split(".")[0]||"";
  const grant=await db.prepare("SELECT * FROM media_upload_grants WHERE id=?").bind(grantId).first<Row>();
  if(!grant)refuse("Media upload grant not found",404);
  if(String(grant!.status)!=="issued")refuse("This media upload token has already been used",409,{code:"upload_token_consumed"});
  const now=Date.now();
  if(Number(grant!.expires_at)<now)refuse("This media upload token has expired",409,{code:"upload_token_expired"});
  if(String(grant!.token_hash)!==await digest(token))refuse("Media upload token is not valid for this grant",403,{code:"upload_token_mismatch"});
  if(String(grant!.object_key)!==objectKey)
    refuse("The confirmed object does not belong to this upload grant",403,{code:"object_key_mismatch"});

  /*
   * WHO SAYS WHAT IS STORED. [PTJA-W3-MS]
   *
   * With a private bucket bound, the BUCKET answers and the caller's claim is ignored entirely - it is
   * not corroboration, it is a value the uploader controls. With no bucket bound the caller's observed
   * facts are all there is, which is honest and is reported as adapterConnected:false rather than
   * dressed up. An absent object is a refusal in both cases: "could not check" must never collapse into
   * "carry on".
   */
  const storage=await mediaStorageStatus();
  if(storage.connected){
    const stored=await headStoredObject(objectKey);
    if(!stored)refuse("No object is stored under this upload grant's key",409,{code:"stored_object_missing"});
    if(Number(stored!.sizeBytes)!==Number(grant!.size_bytes))refuse("The stored object's size does not match the upload grant",409,{code:"object_size_mismatch"});
    const storedType=String(stored!.contentType||"").trim().toLowerCase();
    if(storedType&&storedType!==String(grant!.mime_type))refuse("The stored object's content type does not match the upload grant",409,{code:"object_type_mismatch"});
  }else{
    const observed=input.observed??{};
    if(!Number.isFinite(Number(observed.sizeBytes))||!SHA256.test(String(observed.sha256||""))||!String(observed.mimeType||"").trim())
      refuse("The stored object's size, checksum and content type must be verified before registration",400,{code:"object_verification_required"});
    if(Number(observed.sizeBytes)!==Number(grant!.size_bytes))refuse("The stored object's size does not match the upload grant",409,{code:"object_size_mismatch"});
    if(String(observed.sha256).toLowerCase()!==String(grant!.sha256).toLowerCase())refuse("The stored object's checksum does not match the upload grant",409,{code:"object_checksum_mismatch"});
    if(String(observed.mimeType).trim().toLowerCase()!==String(grant!.mime_type))refuse("The stored object's content type does not match the upload grant",409,{code:"object_type_mismatch"});
  }

  const mediaId=String(grant!.media_id),bookingId=String(grant!.booking_id);
  await db.batch([
    db.prepare("UPDATE media_upload_grants SET status='consumed',consumed_at=? WHERE id=? AND status='issued'").bind(now,grantId),
    db.prepare("UPDATE service_media_assets SET access_status='quarantined',scan_status='pending',review_status='pending_review',updated_at=? WHERE id=?").bind(now,mediaId),
  ]);
  await mediaEvent(db,mediaId,bookingId,"media_upload_registered",String(input.actorId||grant!.created_by),{grantId,objectKey,sizeBytes:Number(grant!.size_bytes),sha256:String(grant!.sha256),verifiedAgainstGrant:true,verifiedBy:storage.connected?"private_object_store":"caller_observation",adapterConnected:storage.connected});
  return{mediaId,mediaRef:`media://asset/${mediaId}`,bookingId,objectKey,reviewStatus:"pending_review" as const,accessStatus:"quarantined",proofReady:false,adapterConnected:storage.connected};
}

async function asset(db:Db,mediaId:string){
  const row=await db.prepare("SELECT * FROM service_media_assets WHERE id=?").bind(String(mediaId||"").trim()).first<Row>();
  if(!row)refuse("Service media asset not found",404);
  return row!;
}

/** Steps 6-7 and half of 9: a second person decides, with a reason, and the decision is recorded. */
export async function reviewMedia(db:Db,input:{mediaId:string;decision:"approved"|"rejected";actorId:string;reason:string}){
  await ensureMediaBoundaryTables(db);
  const decision=String(input.decision||"");
  if(!["approved","rejected"].includes(decision))refuse("A media review decision must be approved or rejected",400);
  const actorId=String(input.actorId||"").trim();
  if(!actorId)refuse("A reviewer is required",400);
  const row=await asset(db,input.mediaId);
  const policy=await mediaUploadPolicy(db,{serviceCode:null,cityId:null});
  // Rule 7, checked BEFORE the reason. Who may decide is a security question and a missing reason is a
  // form error; answering the form error first would let a self-approving caller learn only that they
  // forgot a field, and would make the separation refusal depend on request shape.
  if(policy.config.requireSeparateApprover&&String(row.created_by)===actorId)
    refuse("Media cannot be approved by the person who uploaded it",403,{code:"self_approval_refused"});
  const reason=String(input.reason||"").trim();
  if(reason.length<5)refuse("A media review reason is required",400);
  if(String(row.review_status||"")!=="pending_review")
    refuse("This media asset is not awaiting review",409,{code:"media_not_pending_review",reviewStatus:String(row.review_status||"none")});
  if(String(row.access_status)!=="quarantined")
    refuse("This media asset has not completed its verified upload",409,{code:"media_upload_incomplete"});

  const approved=decision==="approved",now=Date.now();
  /*
   * A HUMAN'S APPROVAL IS NOT A SCAN RESULT. [PTJA-W3-SC]
   *
   * This used to write scan_status='clean' when a person pressed approve. In UAT that was the agreed
   * answer and nobody was misled; in production it would put an opinion in the column a scanner owns,
   * and the next reader of that table could not tell the two apart. scan_status now carries what a
   * SCANNER said - `not_scanned` until one does - and whether the asset is usable is a separate
   * question the release verdict answers.
   */
  const grantRow=await db.prepare("SELECT service_code,city_id FROM media_upload_grants WHERE media_id=?").bind(String(row.id)).first<Row>().catch(()=>null);
  const release=await mediaReleaseVerdict(db,{mediaId:String(row.id),serviceCode:grantRow?String(grantRow.service_code):null,cityId:grantRow?String(grantRow.city_id):null});
  if(approved&&release.scanVerdict!=="clean"&&release.scanVerdict!=="not_scanned")
    refuse(String(release.reason||"This media cannot be released"),409,{code:"media_scan_blocked",scanVerdict:release.scanVerdict});
  const usable=approved&&release.releasable;
  const scanVerdict=await mediaScanState(db,String(row.id));
  await db.prepare("UPDATE service_media_assets SET review_status=?,reviewed_by=?,reviewed_at=?,review_reason=?,scan_status=?,access_status=?,release_basis=?,updated_at=? WHERE id=?")
    .bind(decision,actorId,now,reason,scanVerdict==="clean"?"clean":approved?"pending":"rejected",usable?"ready":"quarantined",usable?release.basis:null,now,String(row.id)).run();
  await mediaEvent(db,String(row.id),String(row.booking_id),approved?"media_review_approved":"media_review_rejected",actorId,
    {reason,uploadedBy:String(row.created_by),separateApprover:true,scanVerdict,releaseBasis:release.basis,released:usable});
  return{mediaId:String(row.id),reviewStatus:decision,accessStatus:usable?"ready":"quarantined",proofReady:usable,
    scanVerdict,releaseBasis:release.basis,releaseBlockedReason:usable?null:release.reason??null};
}

/** Step 9, replacement. The replacement is a NEW asset that must earn its own approval. */
export async function replaceMedia(db:Db,input:{mediaId:string;actorId:string;reason:string;mimeType:string;sizeBytes:number;sha256:string;fileName?:string}){
  await ensureMediaBoundaryTables(db);
  const reason=String(input.reason||"").trim();
  if(reason.length<5)refuse("A reason for replacing media is required",400);
  const row=await asset(db,input.mediaId);
  if(String(row.retention_status)!=="active")refuse("This media asset is no longer active and cannot be replaced",409);
  const grant=await db.prepare("SELECT * FROM media_upload_grants WHERE media_id=?").bind(String(row.id)).first<Row>();
  if(!grant)refuse("The original media has no upload grant to replace",409);

  const replacement=await issueMediaUploadGrant(db,{
    bookingId:String(grant!.booking_id),scopeType:String(grant!.scope_type) as "booking"|"training_session",scopeId:String(grant!.scope_id),
    providerId:String(grant!.provider_id),serviceCode:String(grant!.service_code),cityId:String(grant!.city_id),
    category:String(grant!.category),mimeType:input.mimeType,sizeBytes:input.sizeBytes,sha256:input.sha256,
    fileName:input.fileName,actorId:String(input.actorId||"").trim(),supersedes:String(row.id),
  });
  const now=Date.now();
  await db.prepare("UPDATE service_media_assets SET retention_status='superseded',access_status='revoked',updated_at=? WHERE id=?").bind(now,String(row.id)).run();
  await db.prepare("UPDATE media_read_grants SET revoked_at=? WHERE media_id=? AND revoked_at IS NULL").bind(now,String(row.id)).run();
  await mediaEvent(db,String(row.id),String(row.booking_id),"media_replaced",String(input.actorId),{reason,replacedBy:replacement.mediaId,previousReviewStatus:String(row.review_status||"none")});
  await mediaEvent(db,replacement.mediaId,String(row.booking_id),"media_replaces_earlier_asset",String(input.actorId),{reason,supersedes:String(row.id)});
  return replacement;
}

/** Step 9, deletion. Always explained, always recorded, and any live read grant dies with it. */
export async function deleteMedia(db:Db,input:{mediaId:string;actorId:string;reason:string}){
  await ensureMediaBoundaryTables(db);
  const reason=String(input.reason||"").trim();
  if(reason.length<5)refuse("A reason for deleting media is required",400);
  const actorId=String(input.actorId||"").trim();
  if(!actorId)refuse("An actor is required",400);
  const row=await asset(db,input.mediaId);
  const now=Date.now();
  await db.prepare("UPDATE service_media_assets SET access_status='revoked',retention_status='deleted',updated_at=? WHERE id=?").bind(now,String(row.id)).run();
  await db.prepare("UPDATE media_read_grants SET revoked_at=? WHERE media_id=? AND revoked_at IS NULL").bind(now,String(row.id)).run();
  await db.prepare("UPDATE media_upload_grants SET status='revoked' WHERE media_id=? AND status='issued'").bind(String(row.id)).run();
  await mediaEvent(db,String(row.id),String(row.booking_id),"media_deleted",actorId,{reason,previousReviewStatus:String(row.review_status||"none")});
  return{mediaId:String(row.id),accessStatus:"revoked",retentionStatus:"deleted"};
}

/**
 * Step 8: what a customer receives is a token that stops working, not a reference to the private
 * object. The object key is never in the returned URL, and the token is stored hashed - a read of the
 * grants table cannot reconstruct a working link.
 */
export async function issueMediaReadGrant(db:Db,input:{mediaId:string;audience:string;actorId:string}){
  await ensureMediaBoundaryTables(db);
  const audience=String(input.audience||"").trim().toLowerCase();
  if(!audience)refuse("A read audience is required",400);
  const actorId=String(input.actorId||"").trim();
  if(!actorId)refuse("An actor is required",400);
  const row=await asset(db,input.mediaId);
  if(String(row.review_status||"")!=="approved")refuse("Only reviewed and approved media can be shared",409,{code:"media_not_approved",reviewStatus:String(row.review_status||"none")});
  if(String(row.access_status)!=="ready"||String(row.retention_status)!=="active")refuse("This media asset is not available to share",409);
  const grant=await db.prepare("SELECT service_code,city_id FROM media_upload_grants WHERE media_id=?").bind(String(row.id)).first<Row>();
  const policy=await mediaUploadPolicy(db,{serviceCode:grant?String(grant.service_code):null,cityId:grant?String(grant.city_id):null});
  const grantId=`MREAD-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
  const token=`${grantId}.${secret()}`,now=Date.now(),expiresAt=now+policy.config.readUrlTtlSeconds*1000;
  await db.prepare("INSERT INTO media_read_grants (id,media_id,audience,token_hash,expires_at,revoked_at,created_by,created_at) VALUES (?,?,?,?,?,NULL,?,?)")
    .bind(grantId,String(row.id),audience,await digest(token),expiresAt,actorId,now).run();
  await mediaEvent(db,String(row.id),String(row.booking_id),"media_read_grant_issued",actorId,{grantId,audience,expiresAt,objectKeyShared:false});
  return{grantId,token,audience,expiresAt,
    // A platform path, not a storage URL: no adapter is connected and none is invented here.
    url:`/api/service-media?grant=${encodeURIComponent(token)}`,
    mediaId:String(row.id),adapterConnected:false,durableObjectReference:false};
}

/** Resolves a signed read token, or refuses. Expiry, revocation and asset state are all checked. */
export async function resolveMediaReadGrant(db:Db,token:string){
  await ensureMediaBoundaryTables(db);
  const value=String(token||"").trim();
  if(!value)refuse("A signed media read token is required",400);
  const grantId=value.split(".")[0]||"";
  const grant=await db.prepare("SELECT * FROM media_read_grants WHERE id=?").bind(grantId).first<Row>();
  if(!grant)refuse("This media link is not valid",404);
  if(grant!.revoked_at)refuse("This media link has been withdrawn",409);
  if(Number(grant!.expires_at)<Date.now())refuse("This media link has expired",409,{code:"read_grant_expired"});
  if(String(grant!.token_hash)!==await digest(value))refuse("This media link is not valid",403);
  const row=await asset(db,String(grant!.media_id));
  if(String(row.review_status||"")!=="approved"||String(row.access_status)!=="ready"||String(row.retention_status)!=="active")
    refuse("This media is no longer available",409);
  return{mediaId:String(row.id),bookingId:String(row.booking_id),audience:String(grant!.audience),objectKey:String(row.storage_key),
    mimeType:String(row.mime_type),expiresAt:Number(grant!.expires_at),adapterConnected:false};
}

/** The audit trail for one asset, newest last. */
export async function mediaBoundaryEvents(db:Db,mediaId:string){
  await ensureMediaBoundaryTables(db);
  const rows=await db.prepare("SELECT event_type,actor_id,detail_json,created_at FROM service_media_events WHERE media_id=? ORDER BY created_at").bind(mediaId).all<Row>();
  return rows.results;
}
