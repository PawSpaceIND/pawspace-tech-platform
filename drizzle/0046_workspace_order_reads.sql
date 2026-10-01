-- In-app acknowledgement only; no dispatch, payment or booking mutation.
CREATE TABLE IF NOT EXISTS workspace_order_reads (
 recipient_key TEXT NOT NULL,
 event_id TEXT NOT NULL,
 read_at INTEGER NOT NULL,
 PRIMARY KEY (recipient_key,event_id)
);
