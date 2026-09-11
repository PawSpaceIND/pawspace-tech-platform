CREATE TABLE IF NOT EXISTS gce_goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  goal_type TEXT NOT NULL CHECK(goal_type IN ('growth','revenue','conversion','acquisition','supply','fulfillment','quality','retention','finance','recruitment','custom')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
  owner_type TEXT NOT NULL DEFAULT 'founder' CHECK(owner_type IN ('founder','atlas','vertical_head')),
  owner_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','active','paused','completed','cancelled')),
  autonomy_mode TEXT NOT NULL DEFAULT 'recommend' CHECK(autonomy_mode IN ('recommend','approval_required','execute_within_envelope')),
  service_code TEXT,
  city_id TEXT,
  zone_id TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  approved_by TEXT,
  approved_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gce_goals_active ON gce_goals(status,priority DESC,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS idx_gce_goals_scope ON gce_goals(service_code,city_id,zone_id,status);

CREATE TABLE IF NOT EXISTS gce_budget_envelopes (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  budget_type TEXT NOT NULL CHECK(budget_type IN ('marketing_spend','discount','incentive','provider_payout','customer_credit','communications','recruitment','general')),
  service_code TEXT,
  city_id TEXT,
  zone_id TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  period_type TEXT NOT NULL CHECK(period_type IN ('transaction','daily','weekly','monthly','goal_lifetime')),
  hard_limit_paise INTEGER CHECK(hard_limit_paise IS NULL OR hard_limit_paise >= 0),
  soft_limit_paise INTEGER CHECK(soft_limit_paise IS NULL OR soft_limit_paise >= 0),
  consumed_paise INTEGER NOT NULL DEFAULT 0 CHECK(consumed_paise >= 0),
  max_discount_bps INTEGER CHECK(max_discount_bps IS NULL OR max_discount_bps BETWEEN 0 AND 10000),
  minimum_margin_bps INTEGER CHECK(minimum_margin_bps IS NULL OR minimum_margin_bps BETWEEN 0 AND 10000),
  max_single_action_paise INTEGER CHECK(max_single_action_paise IS NULL OR max_single_action_paise >= 0),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','active','exhausted','expired','cancelled')),
  approved_by TEXT,
  approved_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES gce_goals(id)
);
CREATE INDEX IF NOT EXISTS idx_gce_budget_scope ON gce_budget_envelopes(status,budget_type,service_code,city_id,zone_id);

CREATE TABLE IF NOT EXISTS gce_constraints (
  id TEXT PRIMARY KEY,
  constraint_code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  constraint_type TEXT NOT NULL CHECK(constraint_type IN ('business','financial','operational','legal','safety','communication','provider','customer')),
  enforcement TEXT NOT NULL CHECK(enforcement IN ('advisory','atlas_enforced','platform_hard_block')),
  service_code TEXT,
  city_id TEXT,
  zone_id TEXT,
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(configuration_json)),
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','active','expired','cancelled')),
  approved_by TEXT,
  approved_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gce_constraints_active ON gce_constraints(status,enforcement,effective_from,effective_to);

CREATE TABLE IF NOT EXISTS atlas_tool_gateway_audit (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  agent_code TEXT NOT NULL,
  tool_code TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT,
  policy_decision TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_atlas_gateway_idempotency ON atlas_tool_gateway_audit(idempotency_key) WHERE idempotency_key IS NOT NULL;
