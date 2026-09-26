/**
 * The pay-the-difference reschedule request table (lib/grooming-reschedule-payment.ts), shared with the
 * read-only Ops views so a cold D1 never answers "no such table". One open request per booking: a new
 * quote refreshes the open one rather than stacking slot holds.
 */
export function groomingRescheduleRequestSchema(db:D1Database){return[
 db.prepare("CREATE TABLE IF NOT EXISTS grooming_reschedule_requests (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,payment_id TEXT NOT NULL,from_start TEXT NOT NULL,from_end TEXT NOT NULL,to_start TEXT NOT NULL,to_end TEXT NOT NULL,current_provider_id TEXT,target_provider_id TEXT,provider_changes INTEGER NOT NULL DEFAULT 0,booked_amount REAL NOT NULL,new_slot_amount REAL NOT NULL,difference_amount REAL NOT NULL,booking_total_before REAL NOT NULL,new_total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',quote_json TEXT NOT NULL DEFAULT '{}',consent_revision TEXT NOT NULL,reason TEXT,hold_group_id TEXT,hold_expires_at INTEGER,intent_id TEXT,gateway_order_id TEXT,gateway_payment_id TEXT,status TEXT NOT NULL,failure_reason TEXT,refund_case_id TEXT,requested_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,paid_at INTEGER,applied_at INTEGER)"),
 db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_grooming_reschedule_open_request ON grooming_reschedule_requests(booking_id) WHERE status IN ('quoted','awaiting_payment')"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_grooming_reschedule_requests_status ON grooming_reschedule_requests(status,hold_expires_at)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_grooming_reschedule_requests_intent ON grooming_reschedule_requests(intent_id)"),
];}

export async function ensureGroomingRescheduleRequestTable(db:D1Database){
 await db.batch(groomingRescheduleRequestSchema(db));
}
