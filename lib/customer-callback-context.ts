type Row=Record<string,unknown>;
type Owner={customerId:string;idempotencyKey:string;phoneKey:string};
export type CallbackDispatchContext={requestedStart:string|null;petId:string|null;serviceCode:string|null;leadId:string|null;serviceDate:string|null;cityId:string;bookingId:string|null};
const text=(value:unknown)=>String(value??"").trim();
const nullable=(value:unknown)=>value==null?null:String(value);
const context=(row:Row):CallbackDispatchContext=>({requestedStart:nullable(row.requested_start),petId:nullable(row.pet_id),serviceCode:nullable(row.service_code),leadId:nullable(row.lead_id),serviceDate:nullable(row.service_date),cityId:text(row.city_id),bookingId:nullable(row.booking_id)});
function assertOwner(row:Row|null,owner:Owner,call=false){
 if(!row||text(row.customer_id)!==owner.customerId||text(row.idempotency_key)!==owner.idempotencyKey||text(row.phone_key)!==owner.phoneKey||call&&text(row.use_case)!=="customer_requested_callback")throw new Response("Callback ownership denied",{status:403});
}

/** Setup finishes before consent. Only an actual concurrent duplicate-column error is recoverable. */
export async function ensureCallbackContextSchema(db:D1Database){
 await db.prepare("CREATE TABLE IF NOT EXISTS ai_callback_request_context (call_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL,customer_id TEXT NOT NULL,requested_start TEXT,pet_id TEXT,service_code TEXT,lead_id TEXT,created_at INTEGER NOT NULL,service_date TEXT,city_id TEXT,booking_id TEXT)").run();
 for(const column of ["service_date","city_id","booking_id"] as const){
  const info=await db.prepare("PRAGMA table_info(ai_callback_request_context)").all<Row>();
  if(info.results.some(row=>text(row.name)===column))continue;
  try{await db.prepare(`ALTER TABLE ai_callback_request_context ADD COLUMN ${column} TEXT`).run();}
  catch(error){
   if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;
   const after=await db.prepare("PRAGMA table_info(ai_callback_request_context)").all<Row>();
   if(!after.results.some(row=>text(row.name)===column))throw error;
  }
 }
 await db.prepare("CREATE TABLE IF NOT EXISTS ai_callback_dispatch_intents (idempotency_key TEXT PRIMARY KEY,customer_id TEXT NOT NULL,phone_key TEXT NOT NULL,requested_start TEXT,pet_id TEXT,service_code TEXT,lead_id TEXT,service_date TEXT,city_id TEXT NOT NULL,booking_id TEXT,created_at INTEGER NOT NULL)").run();
 // Force schema reads before the call path, including existing tables with an incompatible shape.
 await db.prepare("SELECT call_id,idempotency_key,customer_id,requested_start,pet_id,service_code,lead_id,service_date,city_id,booking_id,created_at FROM ai_callback_request_context LIMIT 0").all();
 await db.prepare("SELECT idempotency_key,customer_id,phone_key,requested_start,pet_id,service_code,lead_id,service_date,city_id,booking_id,created_at FROM ai_callback_dispatch_intents LIMIT 0").all();
 // As with the existing booking-conversation trigger, the context write shares the order INSERT transaction.
 // Failure aborts the order before the unchanged canonical engine can contact a provider.
 const triggerSql=`CREATE TRIGGER IF NOT EXISTS trg_callback_context_before_dispatch_v1
 AFTER INSERT ON voice_call_orders
 WHEN NEW.use_case='customer_requested_callback' AND EXISTS(SELECT 1 FROM ai_callback_dispatch_intents WHERE idempotency_key=NEW.idempotency_key)
 BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ai_callback_dispatch_intents i WHERE i.idempotency_key=NEW.idempotency_key AND i.customer_id=NEW.customer_id AND i.phone_key=NEW.phone_key AND i.city_id=NEW.city_id AND COALESCE(i.booking_id,'')=COALESCE(NEW.booking_id,'') AND COALESCE(i.lead_id,'')=COALESCE(NEW.lead_id,'')) THEN RAISE(ABORT,'callback_context_owner_mismatch') END;
  INSERT INTO ai_callback_request_context (call_id,idempotency_key,customer_id,requested_start,pet_id,service_code,lead_id,service_date,city_id,booking_id,created_at)
  SELECT NEW.id,i.idempotency_key,i.customer_id,i.requested_start,i.pet_id,i.service_code,i.lead_id,i.service_date,i.city_id,i.booking_id,i.created_at FROM ai_callback_dispatch_intents i WHERE i.idempotency_key=NEW.idempotency_key;
 END`;
 await db.prepare(triggerSql).run();
 const trigger=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_callback_context_before_dispatch_v1'").first<Row>();
 const normalize=(sql:unknown)=>text(sql).replace(/IF NOT EXISTS\s+/i,"").replace(/\s+/g," ");
 if(!trigger||normalize(trigger.sql)!==normalize(triggerSql))throw new Error("Callback binding trigger is missing or incompatible");
}

/** First validated request wins. A retry never updates the intent or previously bound call context. */
export async function reserveCallbackContext(db:D1Database,owner:Owner,requested:CallbackDispatchContext,asOf:number){
 const prior=await db.prepare("SELECT * FROM voice_call_orders WHERE idempotency_key=?").bind(owner.idempotencyKey).first<Row>();
 let original=requested;
 if(prior){
  assertOwner(prior,owner,true);
  const bound=await db.prepare("SELECT * FROM ai_callback_request_context WHERE call_id=?").bind(prior.id).first<Row>();
  if(bound&&(text(bound.customer_id)!==owner.customerId||text(bound.idempotency_key)!==owner.idempotencyKey))throw new Response("Callback context ownership denied",{status:403});
  // Owned legacy calls have no added date metadata; do not backfill those fields from a later retry.
  original=bound?{...context(bound),cityId:text(bound.city_id)||text(prior.city_id),bookingId:nullable(bound.booking_id)??nullable(prior.booking_id)}:{requestedStart:null,petId:null,serviceCode:null,leadId:nullable(prior.lead_id),serviceDate:null,cityId:text(prior.city_id),bookingId:nullable(prior.booking_id)};
 }
 await db.prepare("INSERT INTO ai_callback_dispatch_intents (idempotency_key,customer_id,phone_key,requested_start,pet_id,service_code,lead_id,service_date,city_id,booking_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING").bind(owner.idempotencyKey,owner.customerId,owner.phoneKey,original.requestedStart,original.petId,original.serviceCode,original.leadId,original.serviceDate,original.cityId,original.bookingId,asOf).run();
 const intent=await db.prepare("SELECT * FROM ai_callback_dispatch_intents WHERE idempotency_key=?").bind(owner.idempotencyKey).first<Row>();
 assertOwner(intent,owner);
 const dispatch=context(intent!);
 if(!dispatch.cityId)throw new Response("Callback destination is missing",{status:409});
 if(prior){
  // Pre-existing calls replay without inserting a new order. Backfill missing context before consent.
  await db.prepare("INSERT INTO ai_callback_request_context (call_id,idempotency_key,customer_id,requested_start,pet_id,service_code,lead_id,service_date,city_id,booking_id,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM voice_call_orders WHERE id=? AND customer_id=? AND idempotency_key=? AND use_case='customer_requested_callback' AND phone_key=?) ON CONFLICT(call_id) DO NOTHING").bind(prior.id,owner.idempotencyKey,owner.customerId,dispatch.requestedStart,dispatch.petId,dispatch.serviceCode,dispatch.leadId,dispatch.serviceDate,dispatch.cityId,dispatch.bookingId,asOf,prior.id,owner.customerId,owner.idempotencyKey,owner.phoneKey).run();
  const bound=await db.prepare("SELECT * FROM ai_callback_request_context WHERE call_id=?").bind(prior.id).first<Row>();
  if(!bound||text(bound.customer_id)!==owner.customerId||text(bound.idempotency_key)!==owner.idempotencyKey)throw new Response("Callback context ownership denied",{status:403});
  const stored={...context(bound),cityId:text(bound.city_id)||text(prior.city_id),bookingId:nullable(bound.booking_id)??nullable(prior.booking_id)};
  if((Object.keys(dispatch) as Array<keyof CallbackDispatchContext>).some(key=>stored[key]!==dispatch[key]))throw new Response("Callback context does not match its original request",{status:409});
 }
 return dispatch;
}

export type WebChatCallbackRequest={message:string;requestedStart:string|number|null;serviceDate:string|null;cityId?:string;bookingId:string|null;petId:string|null;serviceCode:string|null;leadId:string|null};
/** The direct chat lane also remembers unsupported requests, which have no dispatch intent. */
export async function reserveWebChatCallbackRequest(db:D1Database,customerId:string,requestKey:string,request:WebChatCallbackRequest){
 await db.prepare("CREATE TABLE IF NOT EXISTS web_chat_callback_requests (request_key TEXT PRIMARY KEY,customer_id TEXT NOT NULL,request_json TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
 const key=JSON.stringify(["direct-web-chat-callback",customerId,requestKey]);
 await db.prepare("INSERT INTO web_chat_callback_requests (request_key,customer_id,request_json,created_at) VALUES (?,?,?,?) ON CONFLICT(request_key) DO NOTHING").bind(key,customerId,JSON.stringify(request),Date.now()).run();
 const original=await db.prepare("SELECT customer_id,request_json FROM web_chat_callback_requests WHERE request_key=?").bind(key).first<Row>();
 if(!original||text(original.customer_id)!==customerId)throw new Response("Chat callback request ownership denied",{status:403});
 const saved=JSON.parse(text(original.request_json)) as WebChatCallbackRequest;
 if(!saved||typeof saved.message!=="string")throw new Response("Chat callback request is unavailable",{status:503});
 return saved;
}
