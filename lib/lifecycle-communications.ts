import{enqueueCommunication,type CommunicationChannel,type CommunicationPurpose}from"./communication-engine";

/*
 * Bridges the per-vertical customer notification rows into the canonical communication outbox.
 *
 * Every service vertical already writes its own notification row inside the same db.batch() that
 * commits the lifecycle state - lib/walking-lifecycle.ts notify(), boarding-stay-lifecycle.ts,
 * sitting, taxi and training all do it. Those rows are a durable record that a customer SHOULD be
 * told something. Nothing ever turned one into an actual message: none of the five verticals called
 * enqueueCommunication, so the canonical outbox (lib/communication-engine.ts) - with its consent
 * gate, quiet hours, retry/backoff and dead-letter queue - never saw a single lifecycle event.
 * grep for enqueueCommunication across lib/*lifecycle*.ts before this module and there are no hits.
 *
 * WHY A BRIDGE AND NOT A CALL AT EACH SITE. enqueueCommunication performs its own multi-statement
 * writes (thread, participant, message+thread batch, outbox). It cannot be composed into a caller's
 * db.batch([...]), so it can only run AFTER the lifecycle transaction has already committed. Reading
 * the rows that batch just wrote is therefore both the correct ordering and the only ordering: the
 * core state is durable before any external-messaging concern is even considered.
 *
 * WHY IT CANNOT THROW. enqueueCommunication throws for reasons that have nothing to do with whether
 * the service happened:
 *
 *   - policy() throws "No active communication policy for city" for every city_id that has no
 *     seeded row, and only 'blr' is seeded (seedCommunicationPolicy). A booking in any other city
 *     would raise from here.
 *   - a missing customer/template/idempotency key throws.
 *   - the message insert rethrows anything that is not the documented duplicate race.
 *
 * A completed walk must not become a 500 because the pilot has no policy row for a second city, so
 * every failure is caught per row, recorded in lifecycle_communication_failures with the provider
 * detail that would otherwise be lost, and skipped. The lifecycle result the caller already holds is
 * returned unchanged. This is the boundary discipline lib/voice-safe-fetch.ts and
 * lib/provider-response-bounds.ts apply to outbound voice, applied to outbound messaging.
 *
 * WHY status IS NOT REUSED AS THE PROGRESS MARKER. app/api/prelaunch-booking-swarm/route.ts counts
 * any vertical notification whose status is outside ('queued','sandbox','suppressed') as evidence of
 * LIVE customer delivery and fails the prelaunch gate on it. Writing 'enqueued' back into that
 * column would trip that gate from a purely internal hand-off. Progress is tracked in a separate
 * ledger, lifecycle_communication_links, and the vertical rows are left exactly as the verticals
 * wrote them.
 */

type Db=D1Database;
type Row=Record<string,unknown>;

const text=(value:unknown)=>String(value??"").trim();

/**
 * The vertical notification tables, and the column each one uses for the human-readable body.
 * Four share one shape; training carries payload_json and a programme_id instead of message/event_id.
 */
export const LIFECYCLE_NOTIFICATION_SOURCES={
 booking_customer_notifications:{body:"message",event:"event_id"},
 walking_customer_notifications:{body:"message",event:"event_id"},
 sitting_customer_notifications:{body:"message",event:"event_id"},
 taxi_customer_notifications:{body:"message",event:"event_id"},
 training_customer_notifications:{body:"payload_json",event:null},
} as const;

export type LifecycleNotificationSource=keyof typeof LIFECYCLE_NOTIFICATION_SOURCES;

/*
 * Channels this bridge will hand to the outbox.
 *
 * The verticals also write 'push' rows, and 'push' is a valid CommunicationChannel, but
 * INT-COMMS-04 records no push provider as selected - communicationAdapterCatalog lists only a
 * placeholder. Enqueuing those would manufacture outbox entries that can never be dispatched and
 * would age into the dead-letter queue on their own. WhatsApp is the requested transactional
 * channel and is the only one with an adapter contract (Meta WhatsApp, INT-COMMS-01); sms is
 * carried because escalateDeadLetteredLifecycleCommunications writes rows on that channel.
 */
const BRIDGED_CHANNELS=new Set<CommunicationChannel>(["whatsapp","sms"]);

/*
 * Purpose decides the consent gate and whether quiet hours apply. A service-state message is
 * 'transactional': it requires a booking link (which every row here has) and correctly ignores
 * quiet hours, because a customer whose walk just started is told at the time it started. Anything
 * describing a failed or recovered service is 'service_recovery', which additionally opens an SLA
 * clock on the thread. Nothing this bridge emits is ever 'marketing'.
 */
const RECOVERY_MARKERS=/no_show|cancel|exception|recovery|reassign|escalat|refund|late|delay|dunning|failed/i;
export function lifecycleCommunicationPurpose(templateCode:string):CommunicationPurpose{
 return RECOVERY_MARKERS.test(templateCode)?"service_recovery":"transactional";
}

export async function ensureLifecycleCommunicationTables(db:Db){
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS lifecycle_communication_links (notification_id TEXT PRIMARY KEY,source_table TEXT NOT NULL,booking_id TEXT NOT NULL,channel TEXT NOT NULL,template_code TEXT NOT NULL,message_id TEXT,outcome TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_comm_links_booking ON lifecycle_communication_links(booking_id,created_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS lifecycle_communication_failures (id TEXT PRIMARY KEY,notification_id TEXT,source_table TEXT NOT NULL,booking_id TEXT,channel TEXT,template_code TEXT,error_name TEXT NOT NULL,error_message TEXT NOT NULL,error_stack TEXT,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_lifecycle_comm_failures_booking ON lifecycle_communication_failures(booking_id,created_at)"),
 ]);
}

/**
 * Records why a hand-off failed, with the detail that a bare status code would have thrown away -
 * the same reason PR #402 added failure capture at the gateway choke point rather than at one
 * assertion. Recording is itself best-effort: if the ledger cannot be written the lifecycle result
 * still stands, so this swallows its own failure rather than defeating the guarantee it exists for.
 */
async function captureFailure(db:Db,detail:{notificationId:string|null;source:LifecycleNotificationSource;bookingId:string|null;channel:string|null;templateCode:string|null;error:unknown}){
 const error=detail.error;
 const name=error instanceof Error?error.name:typeof error;
 const message=error instanceof Error?error.message:text(error)||"unknown failure";
 const stack=error instanceof Error&&error.stack?error.stack.split("\n").slice(0,6).join(" | ").slice(0,2000):null;
 try{
  await db.prepare("INSERT INTO lifecycle_communication_failures (id,notification_id,source_table,booking_id,channel,template_code,error_name,error_message,error_stack,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
   .bind(`LCF-${crypto.randomUUID().slice(0,12).toUpperCase()}`,detail.notificationId,detail.source,detail.bookingId,detail.channel,detail.templateCode,name,message.slice(0,1000),stack,Date.now()).run();
 }catch{/* the lifecycle transaction has already committed; nothing here may surface to the caller */}
}

export type LifecycleBridgeReport={
 enqueued:number;
 duplicates:number;
 suppressed:number;
 skipped:number;
 failed:number;
 messageIds:string[];
};

const EMPTY_REPORT=():LifecycleBridgeReport=>({enqueued:0,duplicates:0,suppressed:0,skipped:0,failed:0,messageIds:[]});

/**
 * Hands every not-yet-bridged notification row for one booking to the canonical outbox.
 *
 * Call it after the lifecycle transaction has committed. It never throws and never rolls anything
 * back: the worst outcome is a report saying nothing was enqueued and a row in
 * lifecycle_communication_failures explaining why.
 */
export async function bridgeLifecycleCommunications(db:Db,input:{bookingId:string;source:LifecycleNotificationSource;actorId?:string}):Promise<LifecycleBridgeReport>{
 const report=EMPTY_REPORT();
 const bookingId=text(input.bookingId);
 if(!bookingId)return report;
 const shape=LIFECYCLE_NOTIFICATION_SOURCES[input.source];
 if(!shape)return report;
 try{
  await ensureLifecycleCommunicationTables(db);
  const rows=await db.prepare(`SELECT n.id,n.booking_id,n.customer_id,n.channel,n.template_code,n.${shape.body} body${shape.event?`,n.${shape.event} event_id`:",NULL event_id"} FROM ${input.source} n LEFT JOIN lifecycle_communication_links l ON l.notification_id=n.id WHERE n.booking_id=? AND l.notification_id IS NULL ORDER BY n.created_at`)
   .bind(bookingId).all<Row>();
  if(!rows.results.length)return report;
  const booking=await db.prepare("SELECT customer_id,city_id,service_code FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
  for(const row of rows.results){
   const notificationId=text(row.id),channel=text(row.channel) as CommunicationChannel,templateCode=text(row.template_code);
   if(!BRIDGED_CHANNELS.has(channel)){report.skipped++;continue;}
   const customerId=text(row.customer_id)||text(booking?.customer_id);
   const cityId=text(booking?.city_id);
   if(!customerId||!cityId){
    report.failed++;
    await captureFailure(db,{notificationId,source:input.source,bookingId,channel,templateCode,error:new Error(customerId?`booking ${bookingId} has no city_id, so no communication policy can be resolved`:`booking ${bookingId} notification ${notificationId} has no customer to address`)});
    continue;
   }
   try{
    const result=await enqueueCommunication(db,{
     customerId,cityId,channel,
     purpose:lifecycleCommunicationPurpose(templateCode),
     idempotencyKey:`LIFECYCLE-${notificationId}`,
     templateKey:templateCode,
     payload:{source:input.source,notificationId,bookingId,serviceCode:text(booking?.service_code)||null,eventId:text(row.event_id)||null,body:text(row.body)},
     createdBy:text(input.actorId)||"lifecycle_bridge",
     bookingId,
    });
    const messageId=text((result as Row).messageId)||text(((result as Row).message as Row|undefined)?.id);
    const outcome=(result as Row).duplicatePrevented?"duplicate":text((result as Row).status)==="suppressed"?"suppressed":"enqueued";
    if(outcome==="duplicate")report.duplicates++;else if(outcome==="suppressed")report.suppressed++;else{report.enqueued++;if(messageId)report.messageIds.push(messageId);}
    await db.prepare("INSERT OR IGNORE INTO lifecycle_communication_links (notification_id,source_table,booking_id,channel,template_code,message_id,outcome,created_at) VALUES (?,?,?,?,?,?,?,?)")
     .bind(notificationId,input.source,bookingId,channel,templateCode,messageId||null,outcome,Date.now()).run();
   }catch(error){
    report.failed++;
    await captureFailure(db,{notificationId,source:input.source,bookingId,channel,templateCode,error});
   }
  }
 }catch(error){
  report.failed++;
  await captureFailure(db,{notificationId:null,source:input.source,bookingId,channel:null,templateCode:null,error});
 }
 return report;
}

/**
 * SMS fallback, placed where a fallback can actually be decided.
 *
 * The outbox does not switch channels on its own, and a fallback cannot be chosen at enqueue time
 * because at that point nothing has failed yet. A WhatsApp message that exhausts max_attempts is
 * moved to 'dead_letter' by failOutboxAttempt; that terminal state is the only honest trigger. This
 * sweep re-enqueues those on sms with a distinct idempotency key, once, and only for
 * service-affecting templates - a dead-lettered message about a completed walk is history, whereas
 * a customer who never learned their walker is late still needs telling.
 *
 * Like the bridge, it never throws.
 */
export async function escalateDeadLetteredLifecycleCommunications(db:Db,input?:{bookingId?:string}):Promise<LifecycleBridgeReport>{
 const report=EMPTY_REPORT();
 try{
  await ensureLifecycleCommunicationTables(db);
  const scoped=text(input?.bookingId);
  const rows=await db.prepare(`SELECT m.id,m.customer_id,m.booking_id,m.template_key,m.payload_json,l.notification_id,l.source_table FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id JOIN lifecycle_communication_links l ON l.message_id=m.id WHERE o.status='dead_letter' AND m.channel='whatsapp'${scoped?" AND m.booking_id=?":""}`)
   .bind(...(scoped?[scoped]:[])).all<Row>();
  for(const row of rows.results){
   const templateCode=text(row.template_key);
   if(!RECOVERY_MARKERS.test(templateCode)){report.skipped++;continue;}
   const bookingId=text(row.booking_id),notificationId=text(row.notification_id);
   try{
    const booking=await db.prepare("SELECT city_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
    const cityId=text(booking?.city_id);
    if(!cityId){report.failed++;await captureFailure(db,{notificationId,source:text(row.source_table) as LifecycleNotificationSource,bookingId,channel:"sms",templateCode,error:new Error(`booking ${bookingId} has no city_id, so the sms fallback cannot resolve a policy`)});continue;}
    let payload:Record<string,unknown>={};try{payload=JSON.parse(text(row.payload_json))as Record<string,unknown>;}catch{}
    const result=await enqueueCommunication(db,{
     customerId:text(row.customer_id),cityId,channel:"sms",
     purpose:lifecycleCommunicationPurpose(templateCode),
     idempotencyKey:`LIFECYCLE-SMS-FALLBACK-${notificationId||text(row.id)}`,
     templateKey:templateCode,
     payload:{...payload,fallbackFor:text(row.id),fallbackReason:"whatsapp_dead_letter"},
     createdBy:"lifecycle_sms_fallback",
     bookingId,
    });
    if((result as Row).duplicatePrevented)report.duplicates++;
    else if(text((result as Row).status)==="suppressed")report.suppressed++;
    else{report.enqueued++;const messageId=text((result as Row).messageId);if(messageId)report.messageIds.push(messageId);}
   }catch(error){
    report.failed++;
    await captureFailure(db,{notificationId,source:text(row.source_table) as LifecycleNotificationSource,bookingId,channel:"sms",templateCode,error});
   }
  }
 }catch(error){
  report.failed++;
  await captureFailure(db,{notificationId:null,source:"booking_customer_notifications",bookingId:text(input?.bookingId)||null,channel:"sms",templateCode:null,error});
 }
 return report;
}
