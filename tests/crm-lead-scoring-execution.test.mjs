import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/voice-harness.mjs";

// Execution coverage for the Diamond CRM lead score. The source-text contract pins the weighting
// expression; this runs scoreLead against a real D1 so the arithmetic and the persistence are exercised
// on data, including the optional-join paths that .catch() over missing tables.
installWorkersHooks("__CRM_SCORE_EXEC_DB__");
const { scoreLead, refreshLeadScores } = await import("../lib/crm-lead-scoring-merge.ts");

function seed(sqlite) {
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'test',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', total_amount REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE lead_attempts (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, channel TEXT, sequence_number INTEGER, outcome TEXT, created_at INTEGER);
    CREATE TABLE lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT, service TEXT, status TEXT NOT NULL DEFAULT 'active', first_action_at INTEGER, updated_at INTEGER NOT NULL);
    INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,created_at,updated_at) VALUES ('CUST-1','blr','Asha Rao','9876500001',NULL,'asha@example.com',1,1);
    INSERT INTO canonical_bookings (id,customer_id,status,total_amount,created_at) VALUES ('BKG-1','CUST-1','completed',9000,1);
    INSERT INTO lead_attempts (id,lead_id,channel,sequence_number,outcome,created_at) VALUES ('ATT-1','LEAD-1','call',1,'Connected',1),('ATT-2','LEAD-1','whatsapp',1,'Interested',1);
  `);
}

test("scoreLead computes the four component scores, a total and a grade, and persists them", async () => {
  const sqlite = freshSqlite();
  seed(sqlite);
  // A recent, high-value training lead with real engagement.
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,service,status,first_action_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("LEAD-1", "CUST-1", "training", "active", Date.now(), Date.now());
  const score = await scoreLead(makeD1(sqlite), "LEAD-1");
  for (const key of ["engagementScore", "profileScore", "recencyScore", "valueScore", "totalScore"]) {
    assert.ok(Number.isInteger(score[key]) && score[key] >= 0 && score[key] <= 100, `${key} must be 0-100, got ${score[key]}`);
  }
  assert.ok(["A", "B", "C", "D"].includes(score.grade));
  // A fresh, engaged, high-value lead should not grade at the floor.
  assert.ok(score.recencyScore >= 85, "a same-day lead should score high on recency");
  const persisted = sqlite.prepare("SELECT total_score,grade FROM lead_scores WHERE lead_id='LEAD-1'").get();
  assert.equal(Number(persisted.total_score), score.totalScore);
  assert.equal(persisted.grade, score.grade);
});

test("scoreLead throws for an unknown lead", async () => {
  const sqlite = freshSqlite();
  seed(sqlite);
  await assert.rejects(scoreLead(makeD1(sqlite), "NOPE"), /Lead not found/);
});

test("refreshLeadScores scores every open lead and skips closed/merged ones", async () => {
  const sqlite = freshSqlite();
  seed(sqlite);
  const now = Date.now();
  const insert = sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,service,status,first_action_at,updated_at) VALUES (?,?,?,?,?,?)");
  insert.run("LEAD-1", "CUST-1", "training", "active", now, now);
  insert.run("LEAD-2", "CUST-1", "grooming", "qualified", now, now);
  insert.run("LEAD-3", "CUST-1", "boarding", "closed", now, now);
  const result = await refreshLeadScores(makeD1(sqlite));
  assert.equal(result.processed, 2); // the closed lead is excluded
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM lead_scores").get().c), 2);
});
