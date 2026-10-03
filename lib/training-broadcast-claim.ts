type Row=Record<string,unknown>;
const conflict=(message:string)=>new Response(message,{status:409});
export async function ensureTrainingBroadcastTables(db:D1Database){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS training_broadcast_offers (booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL,offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_snapshot_json TEXT NOT NULL DEFAULT '[]',responded_at INTEGER,PRIMARY KEY(booking_id,provider_id))"),
 db.prepare("CREATE TABLE IF NOT EXISTS training_broadcast_claims (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,claimed_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS training_broadcast_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1))"),
]);}
/** The caller's canonical ownership moves run in the same D1 batch as the unique winner claim. */
export async function claimTrainingBroadcastOffer(db:D1Database,input:{bookingId:string;providerId:string;sessionId:string;idempotencyKey:string;effectStatements:(guardSql:string,guardBinds:unknown[])=>D1PreparedStatement[];effectPredicate:()=>{sql:string;binds:unknown[]};commitStatements?:(statements:D1PreparedStatement[])=>Promise<unknown>;now?:number}){
 const now=input.now??Date.now(),fingerprint=[input.bookingId,input.providerId,input.sessionId,input.idempotencyKey].join(':');
 if(!input.bookingId||!input.providerId||!input.sessionId||!input.idempotencyKey)throw new Response('Broadcast claim identity is required',{status:400});
 const existing=await db.prepare("SELECT provider_id,session_id,idempotency_key FROM training_broadcast_claims WHERE booking_id=?").bind(input.bookingId).first<Row>();
 if(existing){if(existing.provider_id===input.providerId&&existing.session_id===input.sessionId&&existing.idempotency_key===input.idempotencyKey)return{providerId:input.providerId,duplicatePrevented:true};throw conflict('Training offer already accepted by another claim');}
 const offer=await db.prepare("SELECT status,expires_at,session_id FROM training_broadcast_offers WHERE booking_id=? AND provider_id=?").bind(input.bookingId,input.providerId).first<Row>();
 if(!offer||offer.session_id!==input.sessionId||offer.status!=='pending'||Number(offer.expires_at)<=now)throw conflict('Training broadcast offer is closed or expired');
 const token=crypto.randomUUID(),effect=input.effectPredicate(),effectGuard="EXISTS(SELECT 1 FROM training_broadcast_claims WHERE booking_id=? AND provider_id=? AND idempotency_key=?)",effectBinds=[input.bookingId,input.providerId,input.idempotencyKey],guard="EXISTS(SELECT 1 FROM training_broadcast_offers WHERE booking_id=? AND provider_id=? AND session_id=? AND status='pending' AND expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))) AND NOT EXISTS(SELECT 1 FROM training_broadcast_claims WHERE booking_id=?)",binds=[input.bookingId,input.providerId,input.sessionId,now,input.bookingId];
 try{const statements=[
  db.prepare(`INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN ${guard} THEN 1 ELSE 0 END`).bind(token,...binds),
  db.prepare("INSERT INTO training_broadcast_claims(booking_id,provider_id,session_id,idempotency_key,claimed_at) VALUES(?,?,?,?,?)").bind(input.bookingId,input.providerId,input.sessionId,input.idempotencyKey,now),
  ...input.effectStatements(effectGuard,effectBinds),
  db.prepare("UPDATE training_broadcast_offers SET status=CASE WHEN provider_id=? THEN 'accepted' ELSE 'withdrawn' END,responded_at=? WHERE booking_id=? AND status='pending'").bind(input.providerId,now,input.bookingId),
  db.prepare(`INSERT INTO training_broadcast_assertions(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM training_broadcast_claims WHERE booking_id=? AND provider_id=? AND session_id=? AND idempotency_key=?) AND (SELECT COUNT(*) FROM training_broadcast_offers WHERE booking_id=? AND status='accepted')=1 AND NOT EXISTS(SELECT 1 FROM training_broadcast_offers WHERE booking_id=? AND status='pending') AND (${effect.sql}) THEN 1 ELSE 0 END`).bind(`${token}:final`,input.bookingId,input.providerId,input.sessionId,input.idempotencyKey,input.bookingId,input.bookingId,...effect.binds),
  db.prepare("DELETE FROM training_broadcast_assertions WHERE id=? OR id=?").bind(token,`${token}:final`),
 ];await (input.commitStatements?input.commitStatements(statements):db.batch(statements));}catch(error){const replay=await db.prepare("SELECT provider_id,session_id,idempotency_key FROM training_broadcast_claims WHERE booking_id=?").bind(input.bookingId).first<Row>();if(replay?.provider_id===input.providerId&&replay?.session_id===input.sessionId&&replay?.idempotency_key===input.idempotencyKey)return{providerId:input.providerId,duplicatePrevented:true};if(error instanceof Error&&/constraint/i.test(error.message))throw conflict('Training offer changed before acceptance');throw error;}
 return{providerId:input.providerId,duplicatePrevented:false,fingerprint};
}
