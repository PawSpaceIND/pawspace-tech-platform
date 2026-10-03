-- Isolated D1 only; publisher applies through reviewed migration, never implicit GET.
CREATE TABLE atlas_text_test_requests (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, rate_version TEXT NOT NULL,
 thread_id TEXT NOT NULL, input_upper INTEGER NOT NULL, output_upper INTEGER NOT NULL,
 reserved_micros INTEGER NOT NULL CHECK(reserved_micros>0),
 status TEXT NOT NULL CHECK(status IN ('reserved','completed','unknown')),
 actual_upper_micros INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX atlas_text_test_job ON atlas_text_test_requests(job_id,status);
