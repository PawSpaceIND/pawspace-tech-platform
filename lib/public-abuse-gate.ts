/**
 * Per-IP volume control for endpoints that accept UNAUTHENTICATED writes.
 *
 * Extracted from app/api/public-contact/route.ts, which has carried this gate for some time and whose
 * behaviour an audit probe independently confirmed: exactly PUBLIC_RATE_LIMIT attempts per window, and
 * a refusal rather than a bypass when the origin cannot be determined.
 *
 * It lives here because a second public endpoint needed the same protection and copying it would have
 * left two implementations to keep in step. Each caller passes its own table, so one endpoint's traffic
 * never consumes another's budget.
 *
 * Failing closed on a missing IP is deliberate: an anonymous caller the platform cannot even attribute
 * to an origin is exactly the caller a volume control exists for.
 */
type Db=D1Database;

export const PUBLIC_RATE_WINDOW_MS=10*60*1000;
export const PUBLIC_RATE_LIMIT=5;

const clean=(value:unknown,max:number)=>String(value??"").replace(/[\u0000-\u001F\u007F]/g," ").replace(/\s+/g," ").trim().slice(0,max);

export async function ensurePublicAbuseTable(db:Db,table:string){
 await db.prepare(`CREATE TABLE IF NOT EXISTS ${table} (fingerprint TEXT PRIMARY KEY, window_started_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`).run();
}

/** The caller's origin, hashed. Null when it cannot be established. */
export async function publicFingerprint(request:Request){
 const ip=clean(request.headers.get("cf-connecting-ip"),80);
 if(!ip)return null;
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(ip));
 return Array.from(new Uint8Array(digest)).map(value=>value.toString(16).padStart(2,"0")).join("");
}

/**
 * Count this attempt against the caller's origin. Returns false when the caller is over the limit or
 * cannot be attributed to an origin at all; the caller decides the refusal shape.
 */
export async function withinPublicRateLimit(db:Db,request:Request,input:{table:string;now:number;limit?:number;windowMs?:number}){
 const limit=input.limit??PUBLIC_RATE_LIMIT,windowMs=input.windowMs??PUBLIC_RATE_WINDOW_MS;
 const fingerprint=await publicFingerprint(request);
 if(!fingerprint)return false;
 await ensurePublicAbuseTable(db,input.table);
 const cutoff=input.now-windowMs;
 await db.prepare(`INSERT OR IGNORE INTO ${input.table} (fingerprint,window_started_at,attempts,updated_at) VALUES (?,?,0,?)`).bind(fingerprint,input.now,input.now).run();
 await db.prepare(`UPDATE ${input.table} SET attempts=CASE WHEN window_started_at<? THEN 1 ELSE attempts+1 END,window_started_at=CASE WHEN window_started_at<? THEN ? ELSE window_started_at END,updated_at=? WHERE fingerprint=?`).bind(cutoff,cutoff,input.now,input.now,fingerprint).run();
 const state=await db.prepare(`SELECT attempts FROM ${input.table} WHERE fingerprint=?`).bind(fingerprint).first<{attempts:number}>();
 return Boolean(state)&&Number(state?.attempts)<=limit;
}
