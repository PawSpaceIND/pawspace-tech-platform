-- Legal ownership is explicit. Existing invoices remain unassigned until reviewed by Finance;
-- statutory report generation refuses ambiguous ownership rather than copying global tax totals.
CREATE TABLE IF NOT EXISTS service_invoice_ownership (
 invoice_id TEXT PRIMARY KEY,
 entity_id TEXT NOT NULL,
 registration_id TEXT NOT NULL,
 assigned_by TEXT NOT NULL,
 reason TEXT NOT NULL,
 assigned_at INTEGER NOT NULL
);
