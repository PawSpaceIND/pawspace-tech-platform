type Row=Record<string,unknown>;
type AiBinding={run(model:string,input:unknown):Promise<unknown>};
type VectorIndex={upsert(vectors:Array<{id:string;values:number[];metadata:Record<string,unknown>}>):Promise<unknown>;query(values:number[],options:{topK:number;filter:Record<string,unknown>;returnMetadata?:boolean}):Promise<{matches?:Array<{id:string;score?:number;metadata?:Record<string,unknown>}>}>};
export type AtlasMemoryEnv={AI?:AiBinding;ATLAS_VECTORIZE?:VectorIndex;ATLAS_SECURE_CONTEXT_KEY?:string};

export async function ensureAtlasMemoryTables(db:D1Database){
 const statements=[
  "CREATE TABLE IF NOT EXISTS atlas_vector_memories (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pet_id TEXT,memory_type TEXT NOT NULL DEFAULT 'behavioral',sensitivity TEXT NOT NULL DEFAULT 'non_sensitive' CHECK(sensitivity='non_sensitive'),content_hash TEXT NOT NULL,content_text TEXT NOT NULL,vector_id TEXT NOT NULL UNIQUE,embedding_model TEXT NOT NULL DEFAULT '@cf/baai/bge-m3' CHECK(embedding_model='@cf/baai/bge-m3'),embedding_dimensions INTEGER NOT NULL DEFAULT 1024 CHECK(embedding_dimensions=1024),status TEXT NOT NULL DEFAULT 'active',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_atlas_vector_memories_scope ON atlas_vector_memories(customer_id,pet_id,status,updated_at DESC)",
  "CREATE TABLE IF NOT EXISTS atlas_secure_context_facts (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pet_id TEXT,fact_type TEXT NOT NULL,sensitivity TEXT NOT NULL CHECK(sensitivity IN ('pii','credential','restricted')),ciphertext_b64 TEXT NOT NULL,iv_b64 TEXT NOT NULL,content_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_atlas_secure_context_scope ON atlas_secure_context_facts(customer_id,pet_id,status,updated_at DESC)",
  "CREATE TABLE IF NOT EXISTS atlas_memory_audit (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pet_id TEXT,action TEXT NOT NULL,storage_class TEXT NOT NULL CHECK(storage_class IN ('vector','secure_context')),content_hash TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)",
 ];
 for(const sql of statements)await db.prepare(sql).run();
}
const MODEL="@cf/baai/bge-m3",DIMENSIONS=1024;
const text=(v:unknown)=>String(v??"").trim();
const b64=(bytes:Uint8Array)=>{let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s)};
const fromB64=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
async function hash(value:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return [...new Uint8Array(d)].map(v=>v.toString(16).padStart(2,"0")).join("")}
export function classifyAtlasMemory(content:string){
 const v=text(content);
 const credential=/(?:gate|door|access|lockbox|alarm|entry)\s*(?:code|pin|number)|password|passcode|api[_ -]?key|secret|bearer\s+token|otp\b/i.test(v);
 const pii=/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|(?:\+?91[\s-]?)?[6-9]\d{9}\b|\b\d{12}\b|\b(?:aadhaar|pan|passport|bank account|ifsc)\b/i.test(v);
 return credential?{storage:"secure_context" as const,sensitivity:"credential" as const,factType:"access_credential"}:pii?{storage:"secure_context" as const,sensitivity:"pii" as const,factType:"direct_identifier"}:{storage:"vector" as const,sensitivity:"non_sensitive" as const,factType:"behavioral"};
}
async function key(env:AtlasMemoryEnv){
 const raw=text(env.ATLAS_SECURE_CONTEXT_KEY);if(!raw)throw new Error("ATLAS_SECURE_CONTEXT_KEY is required for secure context");
 const bytes=fromB64(raw);if(bytes.length!==32)throw new Error("ATLAS_SECURE_CONTEXT_KEY must decode to 32 bytes");
 return crypto.subtle.importKey("raw",bytes,"AES-GCM",false,["encrypt","decrypt"]);
}
async function encrypt(env:AtlasMemoryEnv,value:string){const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},await key(env),new TextEncoder().encode(value));return{ciphertextB64:b64(new Uint8Array(cipher)),ivB64:b64(iv)}}
async function embed(env:AtlasMemoryEnv,value:string){
 if(!env.AI)throw new Error("Cloudflare AI binding is required");const raw=await env.AI.run(MODEL,{text:[value]}) as Row;const data=(raw.data??raw) as unknown;
 const vector=Array.isArray(data)&&Array.isArray(data[0])?data[0]:Array.isArray((data as Row)?.data)?((data as Row).data as unknown[])[0]:null;
 if(!Array.isArray(vector)||vector.length!==DIMENSIONS)throw new Error("bge-m3 embedding must be exactly 1024 dimensions");return vector.map(Number);
}export async function storeAtlasMemory(db:D1Database,env:AtlasMemoryEnv,input:{customerId:string;petId?:string|null;content:string;actorId:string}){
 await ensureAtlasMemoryTables(db);
 const content=text(input.content);if(!content)throw new Error("Memory content is required");const classification=classifyAtlasMemory(content),contentHash=await hash(content),now=Date.now(),id=`ATM-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 if(classification.storage==="secure_context"){
  const enc=await encrypt(env,content);
  await db.prepare("INSERT INTO atlas_secure_context_facts(id,customer_id,pet_id,fact_type,sensitivity,ciphertext_b64,iv_b64,content_hash,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'active',?,?,?)").bind(id,input.customerId,input.petId||null,classification.factType,classification.sensitivity,enc.ciphertextB64,enc.ivB64,contentHash,input.actorId,now,now).run();
  await db.prepare("INSERT INTO atlas_memory_audit(id,customer_id,pet_id,action,storage_class,content_hash,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`AMA-${crypto.randomUUID()}`,input.customerId,input.petId||null,"store","secure_context",contentHash,input.actorId,now).run();
  return{id,storage:"secure_context" as const,sensitivity:classification.sensitivity,vectorized:false};
 }
 if(!env.ATLAS_VECTORIZE)throw new Error("ATLAS_VECTORIZE binding is required");const values=await embed(env,content),vectorId=`ATV-${crypto.randomUUID()}`;
 await env.ATLAS_VECTORIZE.upsert([{id:vectorId,values,metadata:{customer_id:input.customerId,pet_id:input.petId||"",sensitivity:"non_sensitive",memory_id:id}}]);
 await db.prepare("INSERT INTO atlas_vector_memories(id,customer_id,pet_id,memory_type,sensitivity,content_hash,content_text,vector_id,embedding_model,embedding_dimensions,status,created_by,created_at,updated_at) VALUES (?,?,?,'behavioral','non_sensitive',?,?,?,?,1024,'active',?,?,?)").bind(id,input.customerId,input.petId||null,contentHash,content,vectorId,MODEL,input.actorId,now,now).run();
 await db.prepare("INSERT INTO atlas_memory_audit(id,customer_id,pet_id,action,storage_class,content_hash,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`AMA-${crypto.randomUUID()}`,input.customerId,input.petId||null,"store","vector",contentHash,input.actorId,now).run();
 return{id,storage:"vector" as const,sensitivity:"non_sensitive" as const,vectorized:true};
}
export async function retrieveAtlasMemoryForLlm(db:D1Database,env:AtlasMemoryEnv,input:{customerId:string;petId?:string|null;query:string;topK?:number}){
 await ensureAtlasMemoryTables(db);
 if(classifyAtlasMemory(input.query).storage==="secure_context")return{matches:[],secureContextExcluded:true};if(!env.ATLAS_VECTORIZE)throw new Error("ATLAS_VECTORIZE binding is required");
 const values=await embed(env,input.query),filter:Record<string,unknown>={customer_id:input.customerId,pet_id:input.petId||"",sensitivity:"non_sensitive"};
 const result=await env.ATLAS_VECTORIZE.query(values,{topK:Math.max(1,Math.min(20,input.topK||6)),filter,returnMetadata:true});const ids=(result.matches||[]).map(m=>text(m.metadata?.memory_id)).filter(Boolean);
 if(!ids.length)return{matches:[],secureContextExcluded:true};
 const rows=await db.prepare(`SELECT id,customer_id,pet_id,memory_type,sensitivity,content_text,vector_id,updated_at FROM atlas_vector_memories WHERE customer_id=? AND sensitivity='non_sensitive' AND status='active' AND id IN (${ids.map(()=>'?').join(",")})`).bind(input.customerId,...ids).all<Row>();
 return{matches:rows.results,secureContextExcluded:true};
}export async function readAtlasSecureContext(db:D1Database,env:AtlasMemoryEnv,input:{customerId:string;petId?:string|null;actorId:string;purpose:"human_operation"|"deterministic_dispatch"}){
 await ensureAtlasMemoryTables(db);
 const rows=await db.prepare("SELECT * FROM atlas_secure_context_facts WHERE customer_id=? AND (pet_id IS NULL OR pet_id=?) AND status='active' ORDER BY updated_at DESC LIMIT 50").bind(input.customerId,input.petId||null).all<Row>();
 const k=await key(env),out=[] as Array<{id:string;factType:string;sensitivity:string;value:string}>;
 for(const row of rows.results){const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64(text(row.iv_b64))},k,fromB64(text(row.ciphertext_b64)));out.push({id:text(row.id),factType:text(row.fact_type),sensitivity:text(row.sensitivity),value:new TextDecoder().decode(plain)})}
 await db.prepare("INSERT INTO atlas_memory_audit(id,customer_id,pet_id,action,storage_class,content_hash,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`AMA-${crypto.randomUUID()}`,input.customerId,input.petId||null,`read:${input.purpose}`,"secure_context","not_exposed",input.actorId,Date.now()).run();
 return{facts:out,forLlm:false};
}
export const ATLAS_VECTOR_MEMORY_MODEL=MODEL;
export const ATLAS_VECTOR_DIMENSIONS=DIMENSIONS;
export const ATLAS_VECTOR_METRIC="cosine" as const;