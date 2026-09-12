type Db=D1Database;

const THREADS_TABLE="CREATE TABLE IF NOT EXISTS communication_threads (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,booking_id TEXT,lead_id TEXT,ticket_id TEXT,status TEXT NOT NULL DEFAULT 'open',assigned_to TEXT,sla_due_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
const THREADS_INDEX="CREATE INDEX IF NOT EXISTS idx_communication_threads_customer ON communication_threads(customer_id,updated_at)";
const PARTICIPANTS_TABLE="CREATE TABLE IF NOT EXISTS communication_participants (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,participant_type TEXT NOT NULL,participant_id TEXT NOT NULL,display_ref TEXT,role TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(thread_id,participant_type,participant_id))";

/**
 * Open the customer conversation as part of the canonical-booking INSERT itself.
 * D1/SQLite triggers execute in the INSERT transaction, so a later statement failure
 * rolls the booking, thread and participant back together. Existing bookings are
 * deliberately not backfilled by this helper.
 */
const bookingConversationReady=new WeakSet<Db>();
const bookingConversationEnsuring=new WeakMap<Db,Promise<void>>();
async function bookingConversationSchemaReady(db:Db){
  const rows=await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('communication_threads','idx_communication_threads_customer','communication_participants','trg_canonical_booking_customer_conversation')").all<Record<string,unknown>>();
  const names=new Set(rows.results.map(row=>String(row.name)));
  return names.size===4;
}

export async function ensureBookingConversationOnInsert(db:Db){
  if(bookingConversationReady.has(db))return;
  const active=bookingConversationEnsuring.get(db);if(active)return active;
  const work=(async()=>{
    if(await bookingConversationSchemaReady(db)){bookingConversationReady.add(db);return;}
    await db.batch([
      db.prepare(THREADS_TABLE),
      db.prepare(THREADS_INDEX),
      db.prepare(PARTICIPANTS_TABLE),
    ]);
    await db.prepare(`CREATE TRIGGER IF NOT EXISTS trg_canonical_booking_customer_conversation
    AFTER INSERT ON canonical_bookings
    BEGIN
      INSERT INTO communication_threads
        (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at)
      SELECT 'THREAD-BOOKING-'||NEW.id,NEW.customer_id,NEW.id,NULL,NULL,'open',NULL,NULL,NEW.created_at,NEW.created_at
      WHERE NOT EXISTS (
        SELECT 1 FROM communication_threads
        WHERE customer_id=NEW.customer_id
          AND booking_id=NEW.id
          AND COALESCE(lead_id,'')=''
          AND COALESCE(ticket_id,'')=''
          AND status='open'
      );

      INSERT INTO communication_participants
        (id,thread_id,participant_type,participant_id,display_ref,role,created_at)
      SELECT 'PART-'||lower(hex(randomblob(16))),t.id,'customer',NEW.customer_id,NEW.customer_id,'customer',NEW.created_at
      FROM communication_threads t
      WHERE t.customer_id=NEW.customer_id
        AND t.booking_id=NEW.id
        AND COALESCE(t.lead_id,'')=''
        AND COALESCE(t.ticket_id,'')=''
        AND t.status='open'
        AND NOT EXISTS (
          SELECT 1 FROM communication_participants p
          WHERE p.thread_id=t.id
            AND p.participant_type='customer'
            AND p.participant_id=NEW.customer_id
        )
      ORDER BY t.updated_at DESC,t.id DESC
      LIMIT 1;
    END`).run();
    bookingConversationReady.add(db);
  })().finally(()=>{bookingConversationEnsuring.delete(db);});
  bookingConversationEnsuring.set(db,work);
  return work;
}
