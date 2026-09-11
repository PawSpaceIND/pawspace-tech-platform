CREATE TABLE IF NOT EXISTS finance_ai_margin_policies (id TEXT PRIMARY KEY,service_code TEXT NOT NULL DEFAULT '',city_id TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',minimum_margin_bps INTEGER NOT NULL DEFAULT 1000,minimum_margin_paise INTEGER NOT NULL DEFAULT 15000,razorpay_fee_bps INTEGER NOT NULL DEFAULT 200,razorpay_fee_fixed_paise INTEGER NOT NULL DEFAULT 0,effective_from INTEGER NOT NULL,effective_to INTEGER,approved_by TEXT,approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(service_code,city_id,version));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS finance_ai_upgrade_costs (upgrade_code TEXT NOT NULL,service_code TEXT NOT NULL,cost_paise INTEGER NOT NULL CHECK(cost_paise>=0),version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',effective_from INTEGER NOT NULL,effective_to INTEGER,approved_by TEXT,approved_at INTEGER,PRIMARY KEY(upgrade_code,service_code,version));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS finance_ai_margin_decisions (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,dispatch_item_id TEXT,offer_policy_version TEXT NOT NULL,discount_bps INTEGER NOT NULL,upgrade_code TEXT,breakdown_json TEXT NOT NULL,decision TEXT NOT NULL,created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finance_ai_margin_decisions_booking ON finance_ai_margin_decisions(booking_id,created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_sales_propensity_refresh_state (job_key TEXT PRIMARY KEY,score_date TEXT NOT NULL,cursor_lead_id TEXT NOT NULL DEFAULT '',processed_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'running',started_at INTEGER NOT NULL,completed_at INTEGER,updated_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_sales_target_admin_events (id TEXT PRIMARY KEY,target_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL);
