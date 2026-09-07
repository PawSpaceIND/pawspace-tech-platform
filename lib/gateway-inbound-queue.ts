type Db=D1Database;
type Row=Record<string,unknown>;

export type GatewayInboundStatus="RECEIVED"|"PROCESSING"|"RETRY"|"PROCESSED"|"DEAD_LETTER"|"REJECTED";
export type GatewayInboundEnvironment="sandbox"|"uat"|"live";
export type GatewayInboundHandler=(input:{queueId:string;provider:string;routeKey:string;environment:GatewayInboundEnvironment;eventId:string;messageId:string|null;rawBody:string;headers:Headers})=>Promise<unknown>;

const encoder=new TextEncoder();
const text=(value:unknown)=>String(value??"").trim();
const MAX_ATTEMPTS=5;
const DEFAULT_LEASE_MS=60_000;
const RAW_PAYLOAD_RETENTION_MS=7*24*60*60_000;
const BASE_RETRY_MS=60_000;
const MAX_RETRY_MS=60*60_000;
const SAFE_HEADER_NAMES=new Set([
 "content-type","x-razorpay-event-id","x-razorpay-signature","x-hub-signature-256",
 "x-pawspace-email-signature","x-signature","x-pawspace-communication-provider",
 "x-pawspace-communication-timestamp","x-pawspace-communication-signature",
 "x-pawspace-signature","x-pawspace-event-id","x-pawspace-whatsapp-provider",
 "interakt-signature","x-exotel-signature","x-pawspace-voice-signature"
]);

function rows<T=Row>(result:{results?:unknown[]}){return(result.results||[])as T[];}
function hex(buffer:ArrayBuffer){return Array.from(new Uint8Array(buffer)).map(value=>value.toString(16).padStart(2,"0")).join("");}
export async function gatewayInboundPayloadHash(rawBody:string){return hex(await crypto.subtle.digest("SHA-256",encoder.encode(rawBody)));}
function safeHeaders(input:Headers|Record<string,string>|undefined){const headers=input instanceof Headers?input:new Headers(input||{});const out:Record<string,string>={};for(const[name,value]of headers.entries()){const key=name.toLowerCase();if(SAFE_HEADER_NAMES.has(key)&&value.length<=1024)out[key]=value;}return out;}
function parseHeaders(value:unknown){let parsed:Record<string,string>={};try{parsed=JSON.parse(text(value)||"{}")as Record<string,string>;}catch{}return new Headers(parsed);}
function environment(value:unknown):GatewayInboundEnvironment{const mode=text(value).toLowerCase();if(mode==="sandbox"||mode==="uat"||mode==="live")return mode;throw new Error("Inbound webhook environment must be sandbox, uat or live");}
function retryDelayMs(attempt:number){return Math.min(MAX_RETRY_MS,BASE_RETRY_MS*Math.pow(2,Math.max(0,attempt-1)));}
async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}
async function scrubExpiredSignedPaymentPayloads(db:Db,now:number){if(!await tableExists(db,"gateway_webhook_events"))return 0;try{const result=await db.prepare("UPDATE gateway_webhook_events SET raw_payload='{}' WHERE processed_at IS NOT NULL AND processed_at<=? AND raw_payload<>'{}'").bind(now-RAW_PAYLOAD_RETENTION_MS).run();return Number(result.meta?.changes||0);}catch{return 0;}}

export async function ensureGatewayInboundQueueTables(db:Db){
 await db.batch([
  db.prepare(`CREATE TABLE IF NOT EXISTS gateway_inbound_queue (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    route_key TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment IN ('sandbox','uat','live')),
    event_id TEXT NOT NULL,
    message_id TEXT,
    payload_sha256 TEXT NOT NULL,
    raw_payload TEXT,
    headers_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','PROCESSING','RETRY','PROCESSED','DEAD_LETTER','REJECTED')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 12),
    next_attempt_at INTEGER NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    last_error TEXT,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    processed_at INTEGER,
    payload_expires_at INTEGER NOT NULL,
    UNIQUE(provider,environment,route_key,event_id),
    UNIQUE(provider,environment,route_key,payload_sha256)
  )`),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_gateway_inbound_due ON gateway_inbound_queue(status,next_attempt_at,lease_expires_at)"),
  db.prepare(`CREATE TABLE IF NOT EXISTS gateway_inbound_dead_letters (
    queue_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    route_key TEXT NOT NULL,
    environment TEXT NOT NULL,
    event_id TEXT NOT NULL,
    message_id TEXT,
    payload_sha256 TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    failure_reason TEXT NOT NULL,
    dead_lettered_at INTEGER NOT NULL
  )`),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_gateway_inbound_dlq_provider ON gateway_inbound_dead_letters(provider,dead_lettered_at DESC)")
 ]);
}

export async function captureInboundWebhook(db:Db,input:{provider:string;routeKey:string;environment:GatewayInboundEnvironment|string;eventId:string;messageId?:string|null;rawBody:string;headers?:Headers|Record<string,string>;maxAttempts?:number;now?:number;requireMessageId?:boolean}){
 await ensureGatewayInboundQueueTables(db);
 const provider=text(input.provider).toLowerCase(),routeKey=text(input.routeKey),eventId=text(input.eventId),messageId=text(input.messageId)||null,rawBody=String(input.rawBody??"");
 if(!provider||!routeKey)throw new Error("Inbound webhook provider and route key are required");
 if(!eventId)throw new Response("Inbound webhook event ID is required",{status:400});
 if(input.requireMessageId&&!messageId)throw new Response("Inbound webhook message ID is required",{status:400});
 const env=environment(input.environment),hash=await gatewayInboundPayloadHash(rawBody),now=input.now??Date.now(),maxAttempts=Math.max(1,Math.min(12,Math.floor(input.maxAttempts??MAX_ATTEMPTS)));
 await scrubExpiredSignedPaymentPayloads(db,now);
 const byId=await db.prepare("SELECT * FROM gateway_inbound_queue WHERE provider=? AND environment=? AND route_key=? AND event_id=?").bind(provider,env,routeKey,eventId).first<Row>();
 if(byId){if(text(byId.payload_sha256)!==hash)throw new Response("Inbound webhook event ID payload mismatch",{status:409});return{row:byId,duplicatePrevented:true as const,duplicateReason:"event_id"as const};}
 const byPayload=await db.prepare("SELECT * FROM gateway_inbound_queue WHERE provider=? AND environment=? AND route_key=? AND payload_sha256=?").bind(provider,env,routeKey,hash).first<Row>();
 if(byPayload)return{row:byPayload,duplicatePrevented:true as const,duplicateReason:"payload"as const};
 const id=`GIN-${crypto.randomUUID()}`,headersJson=JSON.stringify(safeHeaders(input.headers)),expiresAt=now+RAW_PAYLOAD_RETENTION_MS;
 await db.prepare(`INSERT INTO gateway_inbound_queue
  (id,provider,route_key,environment,event_id,message_id,payload_sha256,raw_payload,headers_json,status,attempts,max_attempts,next_attempt_at,received_at,updated_at,payload_expires_at)
  VALUES (?,?,?,?,?,?,?,?,?,'RECEIVED',0,?,?,?,?,?,?)`)
  .bind(id,provider,routeKey,env,eventId,messageId,hash,rawBody,headersJson,maxAttempts,now,now,now,expiresAt).run();
 const row=await db.prepare("SELECT * FROM gateway_inbound_queue WHERE id=?").bind(id).first<Row>();
 if(!row)throw new Error("Inbound webhook queue persistence failed");
 return{row,duplicatePrevented:false as const,duplicateReason:null};
}

export async function claimInboundWebhook(db:Db,input:{queueId:string;workerId:string;now?:number;leaseMs?:number}){
 await ensureGatewayInboundQueueTables(db);const now=input.now??Date.now(),worker=text(input.workerId);if(!worker)throw new Error("Inbound webhook worker identity is required");
 await db.prepare("UPDATE gateway_inbound_queue SET status='RETRY',lease_owner=NULL,lease_expires_at=NULL,last_error=COALESCE(last_error,'stale processing lease recovered'),next_attempt_at=?,updated_at=? WHERE id=? AND status='PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at<?")
  .bind(now,now,input.queueId,now).run();
 const leaseUntil=now+Math.max(5_000,Math.min(120_000,input.leaseMs??DEFAULT_LEASE_MS));
 const changed=await db.prepare("UPDATE gateway_inbound_queue SET status='PROCESSING',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND status IN ('RECEIVED','RETRY') AND next_attempt_at<=? AND raw_payload IS NOT NULL")
  .bind(worker,leaseUntil,now,input.queueId,now).run();
 if(Number(changed.meta?.changes||0)!==1)return null;
 return db.prepare("SELECT * FROM gateway_inbound_queue WHERE id=? AND lease_owner=?").bind(input.queueId,worker).first<Row>();
}

export async function completeInboundWebhook(db:Db,input:{queueId:string;workerId:string;now?:number}){
 const now=input.now??Date.now();
 const changed=await db.prepare("UPDATE gateway_inbound_queue SET status='PROCESSED',raw_payload=NULL,headers_json='{}',lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,processed_at=?,updated_at=? WHERE id=? AND status='PROCESSING' AND lease_owner=?")
  .bind(now,now,input.queueId,input.workerId).run();
 if(Number(changed.meta?.changes||0)!==1)throw new Error("Inbound webhook completion lost its processing lease");
 return{status:"PROCESSED"as const};
}

export async function failInboundWebhook(db:Db,input:{queueId:string;workerId:string;error:unknown;now?:number}){
 const now=input.now??Date.now(),reason=(input.error instanceof Error?input.error.message:String(input.error||"unknown inbound webhook failure")).slice(0,500);
 const row=await db.prepare("SELECT * FROM gateway_inbound_queue WHERE id=? AND status='PROCESSING' AND lease_owner=?").bind(input.queueId,input.workerId).first<Row>();
 if(!row)throw new Error("Inbound webhook failure lost its processing lease");
 const attempt=Number(row.attempts||0),max=Number(row.max_attempts||MAX_ATTEMPTS),expired=Number(row.payload_expires_at||0)<=now,terminal=attempt>=max||expired;
 if(terminal){
  const failure=expired?`payload_retention_expired: ${reason}`:reason;
  await db.batch([
   db.prepare("UPDATE gateway_inbound_queue SET status='DEAD_LETTER',raw_payload=NULL,headers_json='{}',lease_owner=NULL,lease_expires_at=NULL,last_error=?,processed_at=?,updated_at=? WHERE id=? AND lease_owner=?").bind(failure,now,now,input.queueId,input.workerId),
   db.prepare("INSERT OR REPLACE INTO gateway_inbound_dead_letters (queue_id,provider,route_key,environment,event_id,message_id,payload_sha256,attempts,failure_reason,dead_lettered_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(input.queueId,row.provider,row.route_key,row.environment,row.event_id,row.message_id,row.payload_sha256,attempt,failure,now)
  ]);
  return{status:"DEAD_LETTER"as const,attempts:attempt,reason:failure};
 }
 const delay=retryDelayMs(attempt),next=now+delay;
 await db.prepare("UPDATE gateway_inbound_queue SET status='RETRY',next_attempt_at=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND lease_owner=?")
  .bind(next,reason,now,input.queueId,input.workerId).run();
 return{status:"RETRY"as const,attempts:attempt,nextAttemptAt:next,retryDelayMs:delay,reason};
}

export async function runInboundWebhookAttempt(db:Db,input:{queueId:string;workerId:string;handler:GatewayInboundHandler;now?:number}){
 const work=await claimInboundWebhook(db,{queueId:input.queueId,workerId:input.workerId,now:input.now});if(!work)return{claimed:false as const};
 const rawBody=String(work.raw_payload??"");if(!rawBody){return{claimed:true as const,ok:false as const,failure:await failInboundWebhook(db,{queueId:input.queueId,workerId:input.workerId,error:new Error("Inbound webhook payload is unavailable for retry"),now:input.now})};}
 try{
  const result=await input.handler({queueId:input.queueId,provider:text(work.provider),routeKey:text(work.route_key),environment:environment(work.environment),eventId:text(work.event_id),messageId:text(work.message_id)||null,rawBody,headers:parseHeaders(work.headers_json)});
  await completeInboundWebhook(db,{queueId:input.queueId,workerId:input.workerId,now:input.now});return{claimed:true as const,ok:true as const,result};
 }catch(error){const failure=await failInboundWebhook(db,{queueId:input.queueId,workerId:input.workerId,error,now:input.now});return{claimed:true as const,ok:false as const,error,failure};}
}

export async function drainGatewayInboundQueue(db:Db,handlers:Record<string,GatewayInboundHandler>,input:{limit?:number;now?:number;workerPrefix?:string}={}){
 await ensureGatewayInboundQueueTables(db);const now=input.now??Date.now(),limit=Math.max(1,Math.min(100,Math.floor(input.limit??25))),due=rows(await db.prepare("SELECT id,route_key FROM gateway_inbound_queue WHERE status IN ('RECEIVED','RETRY') AND next_attempt_at<=? ORDER BY next_attempt_at,received_at LIMIT ?").bind(now,limit).all<Row>());let processed=0,retried=0,deadLettered=0,unhandled=0;
 for(const item of due){const routeKey=text(item.route_key),handler=handlers[routeKey],workerId=`${text(input.workerPrefix)||"gateway-inbound"}:${crypto.randomUUID()}`;
  const chosen=handler||async()=>{throw new Error(`No retry handler registered for inbound route ${routeKey}`);};const result=await runInboundWebhookAttempt(db,{queueId:text(item.id),workerId,handler:chosen,now});if(!handler)unhandled++;if(result.claimed&&result.ok)processed++;else if(result.claimed&&"failure"in result&&result.failure?.status==="DEAD_LETTER")deadLettered++;else if(result.claimed)retried++;
 }
 return{examined:due.length,processed,retried,deadLettered,unhandled};
}

export async function purgeExpiredInboundPayloads(db:Db,now=Date.now()){
 await ensureGatewayInboundQueueTables(db);
 const pending=rows(await db.prepare("SELECT id FROM gateway_inbound_queue WHERE raw_payload IS NOT NULL AND payload_expires_at<=? AND status IN ('RECEIVED','RETRY')").bind(now).all<Row>());let deadLettered=0;
 for(const item of pending){const worker=`payload-retention:${crypto.randomUUID()}`,claimed=await claimInboundWebhook(db,{queueId:text(item.id),workerId:worker,now});if(!claimed)continue;const result=await failInboundWebhook(db,{queueId:text(item.id),workerId:worker,error:new Error("Inbound webhook payload retention window expired"),now});if(result.status==="DEAD_LETTER")deadLettered++;}
 const scrubbed=await db.prepare("UPDATE gateway_inbound_queue SET raw_payload=NULL,headers_json='{}',updated_at=? WHERE raw_payload IS NOT NULL AND payload_expires_at<=? AND status IN ('PROCESSED','DEAD_LETTER','REJECTED')").bind(now,now).run();
 const legacySignedPaymentPayloads=await scrubExpiredSignedPaymentPayloads(db,now);
 return{deadLettered,scrubbed:Number(scrubbed.meta?.changes||0),legacySignedPaymentPayloads};
}
