import{enqueueCommunication,ensureCommunicationTables,type CommunicationChannel}from"./communication-engine";
import{dispatchExternalCommunication}from"./communication-provider-boundary";
import{chunkedIn}from"./d1-chunked-in";

type Db=D1Database;
type Row=Record<string,unknown>;
type Env=Record<string,unknown>;

const text=(value:unknown)=>String(value??"").trim();

/**
 * The bridge between the per-vertical notification queues and the governed communication outbox.
 *
 * Before this existed the two were unconnected systems. Every vertical lifecycle writes a row into its
 * own <vertical>_customer_notifications table with status 'queued', and nothing ever moved one past
 * 'queued' except lib/food-fulfilment-governance.ts and app/api/crm-automation/route.ts. Separately,
 * lib/communication-engine.ts maintains communication_outbox with consent, quiet hours, frequency caps,
 * backoff and dead-lettering - and nothing selected next_attempt_at<=now for communications, so nothing
 * drained it either. Measured before writing this: `grep -c communication lib/background-scheduler.ts`
 * returned 0.
 *
 * So: a customer's walk could complete, a notification row could be written, and no message would ever
 * be sent by any code path in the repository. This closes that, in two stages, without touching a single
 * lifecycle file.
 */

/* WHY THE JOIN, and not template_code.
 *
 * template_code on these queues is COARSE. lib/walking-lifecycle.ts binds the literal "walking_update"
 * for walker acceptance (line 34), walk start (line 38) AND walk completion (line 71) alike. Reading
 * template_code alone, those three are indistinguishable, and a pilot that promised "we message you when
 * the walk is done" would message on all three.
 *
 * The distinguishing field is event_id -> the vertical event row's event_type. That column is why the
 * queues carry event_id NOT NULL at all. */
type PilotSource={
 queue:string;
 eventTable:string;
 /** Column on the event table that event_id points at. Every one of these is the primary key `id`. */
 eventTypes:Record<string,string>;
};

/* Only mappings with a REAL source event are listed. Three of the five approved pilot templates have no
 * source anywhere in the schema and are deliberately absent rather than approximated:
 *
 *   pilot_booking_confirmed  - no vertical writes a "confirmed" event. canonical_bookings.status is set
 *                              to 'confirmed' at creation, before any event row exists; there is nothing
 *                              to join to.
 *   pilot_provider_en_route  - 'on_the_way' exists only in training_session_events. Walking, sitting,
 *                              taxi and boarding have no en-route event. Taxi's nearest, pickup_confirmed,
 *                              is arrival, not approach - a different promise to the customer.
 *   pilot_payment_due        - no event type anywhere. The only real signal is
 *                              stay_payment_schedules.status='overdue' (boarding split payments), a row
 *                              state rather than an event, already maintained by sweepOverdueStayBalances.
 *
 * Guessing any of the three would be inventing a business rule and mis-messaging real customers during
 * the Bengaluru pilot. They stay unwired until the product decision is made. */
export const PILOT_SOURCES:PilotSource[]=[
 {queue:"booking_customer_notifications",eventTable:"boarding_stay_events",eventTypes:{host_accepted:"pilot_provider_assigned",checked_out:"pilot_service_complete"}},
 {queue:"walking_customer_notifications",eventTable:"walking_session_events",eventTypes:{walker_accepted:"pilot_provider_assigned",walk_completed:"pilot_service_complete"}},
 {queue:"sitting_customer_notifications",eventTable:"sitting_care_events",eventTypes:{sitter_accepted:"pilot_provider_assigned",checked_out:"pilot_service_complete"}},
 {queue:"taxi_customer_notifications",eventTable:"taxi_trip_events",eventTypes:{driver_accepted:"pilot_provider_assigned",trip_completed:"pilot_service_complete"}},
];

/* training_customer_notifications is shaped differently: it has NO event_id column, so it cannot be
 * joined. It carries exactly one template_code, written only when a programme reaches a terminal state
 * (lib/training-session-lifecycle.ts:69), which makes the template_code itself unambiguous here - the
 * reason it is safe for training and unsafe for the other four. */
export const TRAINING_TEMPLATE_MAP:Record<string,string>={training_review_and_certificate:"pilot_service_complete"};

/* order_notifications is NOT bridged. Despite the similar name it is an in-app inbox (status defaults to
 * 'unread', it has a read_at column) already swept by runOrderNotificationSweep. Dispatching it would
 * deliver every order update twice. Grooming has no notification queue at all - it writes only
 * booking_lifecycle_events - so it contributes nothing to the pilot until one is added. */

/* Push rows are left untouched at 'queued', exactly as they are today. The pilot is WhatsApp
 * transactional alerts; there is no configured push adapter, and bridging push would create outbox
 * entries that can only ever dead-letter. */
const BRIDGED_CHANNEL:CommunicationChannel="whatsapp";

/**
 * Reapplies a chunked read's ORDER BY created_at / LIMIT over the concatenated chunks. Inside
 * chunkedIn both apply PER CHUNK, so across more than one chunk the SQL returns the oldest `limit`
 * rows of each chunk rather than of the set. Wrapping the chunkedIn call is what makes that decision
 * visible at the call site.
 */
const ordered=(rows:Row[],limit:number)=>rows.slice().sort((left,right)=>Number(left.created_at||0)-Number(right.created_at||0)).slice(0,limit);

async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}

/**
 * The city decides which communication policy applies - quiet hours, the 7-day promotional cap, whether
 * the policy is in enforce or observe mode. policy() THROWS when a city has no active policy, so a
 * booking whose city cannot be resolved is skipped with a recorded reason rather than defaulted to
 * "blr". A default here would silently apply Bengaluru's quiet hours to a customer in another city.
 */
async function bookingContext(db:Db,bookingId:string){
 if(!await tableExists(db,"canonical_bookings"))return null;
 const row=await db.prepare("SELECT id,customer_id,city_id,service_code FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
 return row||null;
}

type BridgeOutcome={bridged:number;skipped:Array<{queue:string;id:string;reason:string}>};

async function bridgeRow(db:Db,queue:string,row:Row,templateKey:string,eventType:string,actorId:string,outcome:BridgeOutcome){
 const id=text(row.id),bookingId=text(row.booking_id);
 if(!bookingId){outcome.skipped.push({queue,id,reason:"missing_booking_id"});return;}
 const booking=await bookingContext(db,bookingId);
 const customerId=text(row.customer_id)||text(booking?.customer_id);
 const cityId=text(booking?.city_id);
 /* enqueueCommunication HARD-SUPPRESSES a transactional message with no bookingId, and policy() throws
  * with no city. Both are checked here so the reason lands in this sweep's result instead of surfacing
  * as an opaque exception five frames down. */
 if(!customerId){outcome.skipped.push({queue,id,reason:"missing_customer_id"});return;}
 if(!cityId){outcome.skipped.push({queue,id,reason:"unresolved_city"});return;}
 const result=await enqueueCommunication(db,{
  customerId,cityId,channel:BRIDGED_CHANNEL,purpose:"transactional",
  /* The queue row's own primary key. Re-running the sweep over a row that was enqueued but whose
   * status update was lost re-derives the SAME key, and the UNIQUE index on
   * communication_messages.idempotency_key turns the second enqueue into duplicatePrevented rather
   * than a second message to the customer. */
  idempotencyKey:`bridge:${queue}:${id}`,
  templateKey,
  payload:{sourceQueue:queue,sourceRowId:id,eventType,serviceCode:text(booking?.service_code),message:text(row.message)},
  createdBy:actorId,bookingId,
 });
 /* Guarded on status='queued' so two concurrent scheduler slots cannot both count the same row. The
  * enqueue above is already idempotent; this makes the COUNT honest too. */
 const changed=await db.prepare(`UPDATE ${queue} SET status='bridged' WHERE id=? AND status='queued'`).bind(id).run();
 if(Number(changed.meta?.changes||0)>0&&!("duplicatePrevented" in result&&result.duplicatePrevented))outcome.bridged++;
}

async function bridgeJoinedQueues(db:Db,actorId:string,limit:number,outcome:BridgeOutcome){
 for(const source of PILOT_SOURCES){
  if(!await tableExists(db,source.queue)||!await tableExists(db,source.eventTable))continue;
  /* Through chunkedIn like every other IN-list read in lib/. The event-type set is small and static
   * today, so no chunk boundary is ever crossed - but a list built inline is exactly the shape that
   * silently exceeded D1's 100-parameter cap on /team/analytics and rendered as a confident zero.
   * The rule is structural, so it holds here too rather than by argument about today's length. */
  const rows=ordered(await chunkedIn(Object.keys(source.eventTypes),async(chunk,placeholders)=>{
   const page=await db.prepare(
    `SELECT n.*,e.event_type event_type FROM ${source.queue} n JOIN ${source.eventTable} e ON e.id=n.event_id `+
    `WHERE n.status='queued' AND n.channel=? AND e.event_type IN (${placeholders}) ORDER BY n.created_at LIMIT ?`
   ).bind(BRIDGED_CHANNEL,...chunk,limit).all<Row>();
   return page.results;
  }),limit);
  for(const row of rows){
   const eventType=text(row.event_type),templateKey=source.eventTypes[eventType];
   if(!templateKey)continue;
   try{await bridgeRow(db,source.queue,row,templateKey,eventType,actorId,outcome);}
   catch(error){outcome.skipped.push({queue:source.queue,id:text(row.id),reason:error instanceof Error?error.message:String(error)});}
  }
 }
}

async function bridgeTraining(db:Db,actorId:string,limit:number,outcome:BridgeOutcome){
 const queue="training_customer_notifications";
 if(!await tableExists(db,queue))return;
 const rows=ordered(await chunkedIn(Object.keys(TRAINING_TEMPLATE_MAP),async(chunk,placeholders)=>{
  const page=await db.prepare(`SELECT * FROM ${queue} WHERE status='queued' AND channel=? AND template_code IN (${placeholders}) ORDER BY created_at LIMIT ?`).bind(BRIDGED_CHANNEL,...chunk,limit).all<Row>();
  return page.results;
 }),limit);
 for(const row of rows){
  const templateKey=TRAINING_TEMPLATE_MAP[text(row.template_code)];
  if(!templateKey)continue;
  try{await bridgeRow(db,queue,row,templateKey,text(row.template_code),actorId,outcome);}
  catch(error){outcome.skipped.push({queue,id:text(row.id),reason:error instanceof Error?error.message:String(error)});}
 }
}

/**
 * Stage 2. The outbox has carried next_attempt_at, attempt_count, max_attempts and backoff since it was
 * written, and until now nothing selected against it - lib/financial-lifecycle.ts runs this pattern for
 * Razorpay, and communications had no equivalent.
 *
 * No retry logic lives here on purpose. dispatchExternalCommunication already takes the 'dispatching'
 * lock, applies the timeout, and routes every failure through failOutboxAttempt, which owns the backoff
 * and the dead-letter transition. A second retry policy in the caller would fight it.
 */
async function drainOutbox(db:Db,env:Env,limit:number,asOf:number){
 const due=await db.prepare("SELECT message_id,channel FROM communication_outbox o JOIN communication_messages m ON m.id=o.message_id WHERE o.status IN ('queued','retry_pending','scheduled') AND o.next_attempt_at<=? ORDER BY o.next_attempt_at LIMIT ?").bind(asOf,limit).all<Row>();
 const statuses:Record<string,number>={};const failures:string[]=[];
 for(const row of due.results){
  const messageId=text(row.message_id);
  try{
   const recipient=await recipientFor(db,messageId);
   if(!recipient){statuses.recipient_unknown=(statuses.recipient_unknown||0)+1;continue;}
   const result=await dispatchExternalCommunication(db,env,{messageId,adapterName:"meta_whatsapp",recipient});
   const status=text((result as Row).status)||"unknown";
   statuses[status]=(statuses[status]||0)+1;
  }catch(error){
   /* One unreachable provider must not lose the other twenty-two sweeps sharing this scheduler slot. */
   failures.push(`${messageId}:${error instanceof Error?error.message:String(error)}`);
  }
 }
 return{considered:due.results.length,statuses,failures};
}

/**
 * The recipient is read from the customer record, never from the queue payload. The queue rows carry a
 * customer_id, not a phone number, and dispatchExternalCommunication independently re-checks that the
 * recipient belongs to that customer before sending - so passing anything else here would simply be
 * refused as recipient_customer_mismatch. This resolves the same value that check will look for.
 */
async function recipientFor(db:Db,messageId:string){
 if(!await tableExists(db,"canonical_customers"))return null;
 const row=await db.prepare("SELECT c.primary_phone,c.email,m.channel FROM communication_messages m JOIN canonical_customers c ON c.id=m.customer_id WHERE m.id=?").bind(messageId).first<Row>();
 if(!row)return null;
 return text(row.channel)==="email"?text(row.email)||null:text(row.primary_phone)||null;
}

export async function runCommunicationDispatchBridge(db:Db,env:Env,input:{actorId?:string;asOf?:number;limit?:number}={}){
 const actorId=input.actorId||"system:scheduled-worker";
 const asOf=input.asOf??Date.now();
 const limit=Math.max(1,Math.min(Number(input.limit||50),200));
 await ensureCommunicationTables(db);
 const outcome:BridgeOutcome={bridged:0,skipped:[]};
 await bridgeJoinedQueues(db,actorId,limit,outcome);
 await bridgeTraining(db,actorId,limit,outcome);
 const drained=await drainOutbox(db,env,limit,asOf);
 return{
  bridged:outcome.bridged,
  skipped:outcome.skipped,
  drained,
  /* Stays false until a message is actually accepted by a provider. dispatchExternalCommunication
   * refuses unless PAWSPACE_COMMUNICATION_ENV is "uat", so on staging and production today every drain
   * returns not_configured and nothing leaves the Worker. Reported rather than assumed. */
  externalDelivery:Object.keys(drained.statuses).includes("provider_accepted"),
 };
}
