/**
 * A vendor-neutral scan and quarantine boundary. [PTJA-W3-SC]
 *
 * THE APPROVED RULE, in the business's own words: for UAT, retain honest human review status. Do not
 * rename human review as malware scanning. Create a vendor-neutral scan/quarantine boundary if needed,
 * but production media must remain blocked until either a real scanner reports clean, or an explicitly
 * permitted manual-review policy approves it. A production malware-scanning provider remains an
 * operational blocker.
 *
 * WHAT WAS MEASURED BEFORE. lib/media-upload-boundary's review step wrote scan_status='clean' when a
 * human pressed approve. In UAT that is the agreed answer and nobody is misled. In production it would
 * mean a person's opinion sitting in the column a scanner is supposed to own, and the next reader of
 * that table would have no way to tell the two apart.
 *
 * NO VENDOR IS NAMED. recordScanVerdict takes whatever produced the verdict and refuses an anonymous
 * one. When a scanner is procured it writes here; nothing else changes.
 */
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export const MEDIA_SCAN_POLICY_DOMAIN="media_scan_policy";
export type ScanVerdict="clean"|"infected"|"unreadable";
export type MediaScanState="not_scanned"|ScanVerdict;

export type MediaScanPolicy={
  /**
   * May a named human approve production media while no scanner exists? FALSE by default, because the
   * whole point of the boundary is that "somebody looked at it" is not "it was scanned".
   */
  manualReviewPermittedWithoutScanner:boolean;
  /** Environments where an unscanned file may still be used. UAT only, by default. */
  unscannedPermittedEnvironments:string[];
};

export const APPROVED_MEDIA_SCAN_POLICY:MediaScanPolicy={
  manualReviewPermittedWithoutScanner:false,
  unscannedPermittedEnvironments:["uat","development","test"],
};

registerServicePolicyDomain<MediaScanPolicy&Record<string,unknown>>({
  domain:MEDIA_SCAN_POLICY_DOMAIN,
  label:"Media scanning and quarantine",
  managePermission:"settings.manage",
  defaults:APPROVED_MEDIA_SCAN_POLICY as MediaScanPolicy&Record<string,unknown>,
  problem(config){
    if(typeof config.manualReviewPermittedWithoutScanner!=="boolean")return"The manual-review permission must be true or false";
    const environments=Array.isArray(config.unscannedPermittedEnvironments)?config.unscannedPermittedEnvironments.map(String):null;
    if(!environments)return"The environments where unscanned media is permitted must be a list";
    // Production can be opened only by manualReviewPermittedWithoutScanner, which is a deliberate,
    // reason-carrying decision. Adding "production" to this list would be the same decision taken
    // silently, which is why it is refused here.
    if(environments.some(entry=>entry.trim().toLowerCase()==="production"))
      return"Production cannot be listed as an environment where unscanned media is permitted; use the manual-review permission instead, which is audited";
    return null;
  },
});

const scanReady=new WeakSet<Db>();
export async function ensureMediaScanTables(db:Db){
  if(scanReady.has(db))return;
  await db.prepare("CREATE TABLE IF NOT EXISTS media_scan_verdicts (media_id TEXT PRIMARY KEY,verdict TEXT NOT NULL,provider TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',recorded_at INTEGER NOT NULL)").run();
  scanReady.add(db);
}

async function workerEnv():Promise<Record<string,unknown>>{
  try{const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}catch{return{};}
}

/** The runtime this worker believes it is. Absent is treated as production - the strict reading. */
export async function mediaEnvironment():Promise<string>{
  const env=await workerEnv();
  return text(env.PAWSPACE_MEDIA_ENV).toLowerCase()||"production";
}

export type MediaScanStatus={provider:string;connected:boolean;productionBlocker:boolean;reason:string|null};

export async function mediaScanStatus():Promise<MediaScanStatus>{
  const env=await workerEnv();
  const provider=text(env.PAWSPACE_MEDIA_SCAN_PROVIDER).toLowerCase();
  if(!provider)return{provider:"none",connected:false,productionBlocker:true,
    reason:"No malware-scanning provider is configured. Production media stays blocked unless an explicitly permitted manual-review policy approves it."};
  return{provider,connected:true,productionBlocker:false,reason:null};
}

/**
 * Records what a scanner said. Refuses an anonymous verdict: an unattributed "clean" is precisely the
 * defect this boundary exists to prevent - it is indistinguishable from a human's opinion, which is
 * how the two got confused in the first place.
 */
export async function recordScanVerdict(db:Db,input:{mediaId:string;verdict:ScanVerdict;provider:string;detail?:string}){
  await ensureMediaScanTables(db);
  const mediaId=text(input.mediaId),provider=text(input.provider);
  if(!mediaId)throw Response.json({error:"A media asset is required"},{status:400});
  if(!provider)throw Response.json({error:"A scan verdict must name what produced it",code:"scan_provider_required"},{status:400});
  if(!["clean","infected","unreadable"].includes(String(input.verdict)))
    throw Response.json({error:"A scan verdict must be clean, infected or unreadable"},{status:400});
  await db.prepare("INSERT INTO media_scan_verdicts (media_id,verdict,provider,detail,recorded_at) VALUES (?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET verdict=excluded.verdict,provider=excluded.provider,detail=excluded.detail,recorded_at=excluded.recorded_at")
    .bind(mediaId,String(input.verdict),provider,text(input.detail),Date.now()).run();
  return{mediaId,verdict:input.verdict,provider};
}

export async function mediaScanState(db:Db,mediaId:string):Promise<MediaScanState>{
  await ensureMediaScanTables(db);
  const row=await db.prepare("SELECT verdict FROM media_scan_verdicts WHERE media_id=?").bind(text(mediaId)).first<Row>().catch(()=>null);
  return row?String(row.verdict) as ScanVerdict:"not_scanned";
}

export type ReleaseVerdict={
  releasable:boolean;scanVerdict:MediaScanState;environment:string;
  basis:"scanner_clean"|"permitted_environment"|"manual_review_policy"|"blocked_unscanned"|"blocked_infected";
  reason:string|null;
};

/**
 * May this asset be released for use, given what is known about it?
 *
 * A human's approval is an INPUT to this question, not the answer. `infected` and `unreadable` are
 * absolute: no permission and no environment overrides a scanner that actually looked.
 */
export async function mediaReleaseVerdict(db:Db,input:{mediaId:string;serviceCode?:string|null;cityId?:string|null}):Promise<ReleaseVerdict>{
  const verdict=await mediaScanState(db,input.mediaId);
  const environment=await mediaEnvironment();
  if(verdict==="clean")return{releasable:true,scanVerdict:verdict,environment,basis:"scanner_clean",reason:null};
  if(verdict==="infected"||verdict==="unreadable")
    return{releasable:false,scanVerdict:verdict,environment,basis:"blocked_infected",
      reason:`A scanner reported this file ${verdict}; no review can release it`};

  const policy=await resolveServicePolicy<MediaScanPolicy&Record<string,unknown>>(db,MEDIA_SCAN_POLICY_DOMAIN,{serviceCode:input.serviceCode,cityId:input.cityId});
  if(policy.config.unscannedPermittedEnvironments.map(entry=>String(entry).toLowerCase()).includes(environment))
    return{releasable:true,scanVerdict:verdict,environment,basis:"permitted_environment",reason:null};
  if(policy.config.manualReviewPermittedWithoutScanner)
    return{releasable:true,scanVerdict:verdict,environment,basis:"manual_review_policy",reason:null};
  return{releasable:false,scanVerdict:verdict,environment,basis:"blocked_unscanned",
    reason:"No malware scanner has reported on this file and manual review is not permitted without one in this environment"};
}
