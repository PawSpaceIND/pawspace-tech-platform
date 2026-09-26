-- UAT STAGING Dog Training commercial policies (Bengaluru).
--
-- Founder decisions, 26 Sep 2026:
--   Cancellation / refund: sessions can be changed free of charge until 24 hours before they start; a
--   missed session (no-show) counts as used; cancelling a programme refunds the unused sessions pro-rata
--   (refund basis captured_less_pro_rata_used); PawSpace charges no cancellation fee.
--   Tax: 18% GST, included in the displayed Training price.
--
-- Without these rows every Training cancellation request stops at "policy configuration required" and
-- Training finance refuses with "Published Training tax policy is required". Production policies are
-- published by Finance in /team/finance/training (versioned and audited); this file only seeds the
-- isolated staging database, and never overwrites a policy Finance has already published there.
--
-- The CREATE statements mirror lib/training-cancellation.ts and lib/training-finance.ts exactly so the
-- file also works on a staging database that has not yet served a Training request.

CREATE TABLE IF NOT EXISTS training_cancellation_policies (city_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'configuration_required',version INTEGER NOT NULL DEFAULT 1,refund_basis TEXT NOT NULL DEFAULT 'captured_less_pro_rata_used',fee_type TEXT,fee_value REAL,no_show_treatment TEXT,effective_from TEXT,effective_to TEXT,updated_by TEXT NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS training_tax_policies (city_id TEXT PRIMARY KEY,tax_mode TEXT,tax_rate REAL,status TEXT NOT NULL DEFAULT 'published',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT,effective_to TEXT,updated_by TEXT NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL);

INSERT INTO training_cancellation_policies (city_id,status,version,refund_basis,fee_type,fee_value,no_show_treatment,effective_from,effective_to,updated_by,reason,updated_at)
VALUES ('blr','published',1,'captured_less_pro_rata_used','none',0,'chargeable','2026-09-26',NULL,'uat_staging_seed','Founder decision 26 Sep 2026: free changes until 24h before a session, no-show chargeable, unused sessions refunded pro-rata, no fee',CAST(strftime('%s','now') AS INTEGER)*1000)
ON CONFLICT(city_id) DO UPDATE SET status='published',version=training_cancellation_policies.version+1,refund_basis='captured_less_pro_rata_used',fee_type='none',fee_value=0,no_show_treatment='chargeable',effective_from=excluded.effective_from,effective_to=NULL,updated_by=excluded.updated_by,reason=excluded.reason,updated_at=excluded.updated_at
WHERE training_cancellation_policies.status<>'published';

INSERT INTO training_tax_policies (city_id,tax_mode,tax_rate,status,version,effective_from,effective_to,updated_by,reason,updated_at)
VALUES ('blr','inclusive',18,'published',1,'2026-09-26',NULL,'uat_staging_seed','Founder decision 26 Sep 2026: 18% GST included in the displayed Training price',CAST(strftime('%s','now') AS INTEGER)*1000)
ON CONFLICT(city_id) DO UPDATE SET tax_mode='inclusive',tax_rate=18,status='published',version=training_tax_policies.version+1,effective_from=excluded.effective_from,effective_to=NULL,updated_by=excluded.updated_by,reason=excluded.reason,updated_at=excluded.updated_at
WHERE training_tax_policies.tax_mode IS NULL OR training_tax_policies.tax_rate IS NULL OR training_tax_policies.status<>'published';
