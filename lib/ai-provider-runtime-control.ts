type Env=Record<string,unknown>;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const uid=()=>`AIREQ-${crypto.randomUUID().slice(0,16).toUpperCase()}`;

export type AiRuntimeReservation={id:string;reservedTokens:number;reservedCostMicros:number}|null;
export type AiRuntimePreflight={allowed:true;reservation:AiRuntimeReservation}|{allowed:false;reason:"quota_exceeded"|"circuit_open"|"runtime_control_unavailable"};

const integer=(env:Env,key:string,fallback:number,min:number,max:number)=>{const raw=Number(text(env[key]));if(!Number.isFinite(raw)||raw<=0)return fallback;return Math.min(max,Math.max(min,Math.floor(raw)));};
const dayStart=(now:number)=>Math.floor(now/86_400_000)*86_400_000;

export async function ensureAiProviderRuntimeControl(db:D1Database){
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS ai_provider_runtime_requests (id TEXT PRIMARY KEY,provider TEXT NOT NULL,model_ref TEXT NOT NULL,channel TEXT NOT NULL,intent TEXT NOT NULL,reserved_tokens INTEGER NOT NULL,reserved_cost_micros INTEGER NOT NULL DEFAULT 0,actual_tokens INTEGER,actual_cost_micros INTEGER,status TEXT NOT NULL,failure_class TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_ai_provider_runtime_requests_created ON ai_provider_runtime_requests(created_at,status)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_ai_provider_runtime_requests_provider ON ai_provider_runtime_requests(provider,model_ref,created_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS ai_provider_runtime_circuit (provider TEXT NOT NULL,model_ref TEXT NOT NULL,consecutive_failures INTEGER NOT NULL DEFAULT 0,open_until INTEGER,updated_at INTEGER NOT NULL,PRIMARY KEY(provider,model_ref))"),
 ]);
}

export function estimateAiTokenReservation(systemPrompt:string,userPrompt:string,maxOutputTokens:number){
 const inputEstimate=Math.ceil((systemPrompt.length+userPrompt.length)/4);
 return Math.max(1,inputEstimate+Math.max(1,maxOutputTokens));
}

export async function reserveAiProviderRequest(db:D1Database,env:Env,input:{provider:string;modelRef:string;channel?:string;intent?:string;systemPrompt:string;userPrompt:string;maxOutputTokens:number;asOf?:number}):Promise<AiRuntimePreflight>{
 const now=input.asOf??Date.now();
 try{
  await ensureAiProviderRuntimeControl(db);
  const circuit=await db.prepare("SELECT open_until FROM ai_provider_runtime_circuit WHERE provider=? AND model_ref=? LIMIT 1").bind(input.provider,input.modelRef).first<Row>();
  if(Number(circuit?.open_until||0)>now)return{allowed:false,reason:"circuit_open"};

  const requestsPerMinute=integer(env,"PAWSPACE_AI_MAX_REQUESTS_PER_MINUTE",240,1,10_000);
  const tokensPerDay=integer(env,"PAWSPACE_AI_MAX_RESERVED_TOKENS_PER_DAY",5_000_000,1_000,1_000_000_000);
  const costPer1k=integer(env,"PAWSPACE_AI_ESTIMATED_COST_MICROS_PER_1K_TOKENS",0,0,1_000_000_000);
  const costPerDay=integer(env,"PAWSPACE_AI_MAX_ESTIMATED_COST_MICROS_PER_DAY",0,0,2_000_000_000);
  const reservedTokens=estimateAiTokenReservation(input.systemPrompt,input.userPrompt,input.maxOutputTokens);
  const reservedCostMicros=costPer1k>0?Math.ceil((reservedTokens/1000)*costPer1k):0;
  const id=uid();
  await db.prepare("INSERT INTO ai_provider_runtime_requests (id,provider,model_ref,channel,intent,reserved_tokens,reserved_cost_micros,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'reserved',?,?)")
   .bind(id,input.provider,input.modelRef,text(input.channel)||"direct",text(input.intent)||"direct",reservedTokens,reservedCostMicros,now,now).run();

  const minute=now-60_000,start=dayStart(now);
  const [rpm,daily]=await Promise.all([
   db.prepare("SELECT COUNT(*) count FROM ai_provider_runtime_requests WHERE created_at>=? AND status IN ('reserved','completed','failed')").bind(minute).first<Row>(),
   db.prepare("SELECT COALESCE(SUM(reserved_tokens),0) tokens,COALESCE(SUM(reserved_cost_micros),0) cost FROM ai_provider_runtime_requests WHERE created_at>=? AND status IN ('reserved','completed','failed')").bind(start).first<Row>(),
  ]);
  const overRequests=Number(rpm?.count||0)>requestsPerMinute;
  const overTokens=Number(daily?.tokens||0)>tokensPerDay;
  const overCost=costPerDay>0&&Number(daily?.cost||0)>costPerDay;
  if(overRequests||overTokens||overCost){
   await db.prepare("UPDATE ai_provider_runtime_requests SET status='blocked',failure_class='quota_exceeded',updated_at=? WHERE id=? AND status='reserved'").bind(now,id).run();
   return{allowed:false,reason:"quota_exceeded"};
  }
  return{allowed:true,reservation:{id,reservedTokens,reservedCostMicros}};
 }catch{return{allowed:false,reason:"runtime_control_unavailable"};}
}

export async function completeAiProviderRequest(db:D1Database,env:Env,input:{reservation:AiRuntimeReservation;provider:string;modelRef:string;actualTokens?:number|null;failureClass?:string|null;retryableFailure?:boolean;asOf?:number}){
 if(!input.reservation)return;
 const now=input.asOf??Date.now();
 try{
  await ensureAiProviderRuntimeControl(db);
  const actualTokens=Number.isFinite(Number(input.actualTokens))?Math.max(0,Math.floor(Number(input.actualTokens))):null;
  const costPer1k=integer(env,"PAWSPACE_AI_ESTIMATED_COST_MICROS_PER_1K_TOKENS",0,0,1_000_000_000);
  const actualCost=actualTokens!=null&&costPer1k>0?Math.ceil((actualTokens/1000)*costPer1k):null;
  const status=input.failureClass?"failed":"completed";
  await db.prepare("UPDATE ai_provider_runtime_requests SET status=?,failure_class=?,actual_tokens=?,actual_cost_micros=?,updated_at=? WHERE id=?")
   .bind(status,input.failureClass||null,actualTokens,actualCost,now,input.reservation.id).run();

  if(!input.failureClass){
   await db.prepare("INSERT INTO ai_provider_runtime_circuit (provider,model_ref,consecutive_failures,open_until,updated_at) VALUES (?,?,0,NULL,?) ON CONFLICT(provider,model_ref) DO UPDATE SET consecutive_failures=0,open_until=NULL,updated_at=excluded.updated_at")
    .bind(input.provider,input.modelRef,now).run();
   return;
  }
  if(!input.retryableFailure)return;
  const threshold=integer(env,"PAWSPACE_AI_CIRCUIT_FAILURE_THRESHOLD",5,1,100);
  const cooldown=integer(env,"PAWSPACE_AI_CIRCUIT_COOLDOWN_MS",60_000,1_000,3_600_000);
  const prior=await db.prepare("SELECT consecutive_failures FROM ai_provider_runtime_circuit WHERE provider=? AND model_ref=? LIMIT 1").bind(input.provider,input.modelRef).first<Row>();
  const failures=Number(prior?.consecutive_failures||0)+1;
  const openUntil=failures>=threshold?now+cooldown:null;
  await db.prepare("INSERT INTO ai_provider_runtime_circuit (provider,model_ref,consecutive_failures,open_until,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(provider,model_ref) DO UPDATE SET consecutive_failures=excluded.consecutive_failures,open_until=excluded.open_until,updated_at=excluded.updated_at")
   .bind(input.provider,input.modelRef,failures,openUntil,now).run();
 }catch{
  // Completion accounting is best-effort after the provider request. The preflight itself is fail-closed.
 }
}
