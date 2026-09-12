CREATE TABLE IF NOT EXISTS vet_appointments (
  id TEXT PRIMARY KEY,
  booking_id TEXT UNIQUE,
  customer_id TEXT NOT NULL,
  pet_id TEXT NOT NULL,
  provider_id TEXT,
  triage_level TEXT NOT NULL CHECK(triage_level IN ('emergency','urgent','routine')),
  triage_summary TEXT NOT NULL,
  symptom_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'triaged',
  scheduled_start TEXT,
  scheduled_end TEXT,
  consultation_fee_paise INTEGER NOT NULL DEFAULT 59900 CHECK(consultation_fee_paise=59900),
  service_code TEXT NOT NULL DEFAULT 'vet_consult' CHECK(service_code='vet_consult'),
  sac_code TEXT NOT NULL DEFAULT '998351' CHECK(sac_code='998351'),
  tax_paise INTEGER NOT NULL DEFAULT 0 CHECK(tax_paise=0),
  emergency_handoff_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vet_appointments_customer ON vet_appointments(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vet_appointments_provider ON vet_appointments(provider_id,status,scheduled_start);

CREATE TABLE IF NOT EXISTS vet_prescriptions (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL,
  booking_id TEXT,
  provider_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('handwritten_upload','voice_dictation','typed_notes')),
  source_media_ref TEXT,
  draft_json TEXT NOT NULL,
  pdf_file_ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft_for_vet_review' CHECK(status IN ('draft_for_vet_review','signed','void')),
  veterinarian_signature_ref TEXT,
  signed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(appointment_id) REFERENCES vet_appointments(id)
);
CREATE INDEX IF NOT EXISTS idx_vet_prescriptions_appointment ON vet_prescriptions(appointment_id,created_at DESC);

CREATE TABLE IF NOT EXISTS vet_provider_payout_terms (
  id TEXT PRIMARY KEY,
  provider_id TEXT,
  provider_share_bps INTEGER NOT NULL CHECK(provider_share_bps BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'draft',
  effective_from TEXT NOT NULL,
  created_by TEXT NOT NULL,
  approved_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vet_payout_terms ON vet_provider_payout_terms(provider_id,status,effective_from);

CREATE TABLE IF NOT EXISTS vet_visit_kpis (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  contract_type TEXT NOT NULL CHECK(contract_type IN ('full_time','commission')),
  visit_count INTEGER NOT NULL DEFAULT 1 CHECK(visit_count=1),
  provider_payout_paise INTEGER NOT NULL DEFAULT 0 CHECK(provider_payout_paise>=0),
  platform_retained_paise INTEGER NOT NULL DEFAULT 0 CHECK(platform_retained_paise>=0),
  tax_paise INTEGER NOT NULL DEFAULT 0 CHECK(tax_paise=0),
  created_at INTEGER NOT NULL
);
