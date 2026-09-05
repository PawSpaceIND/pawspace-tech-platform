type Db = D1Database;
type Row = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const rows = <T = Row>(r: { results?: unknown[] }) => (r.results ?? []) as T[];
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

async function tableExists(db: Db, name: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());
}

export async function ensureLeadScoringMergeTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS lead_scores (lead_id TEXT PRIMARY KEY,engagement_score INTEGER NOT NULL,profile_score INTEGER NOT NULL,recency_score INTEGER NOT NULL,value_score INTEGER NOT NULL,total_score INTEGER NOT NULL,grade TEXT NOT NULL,factors_json TEXT NOT NULL,computed_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS lead_scores_total_idx ON lead_scores(total_score DESC,computed_at DESC)"),
    db.prepare("CREATE TABLE IF NOT EXISTS customer_merge_runs (id TEXT PRIMARY KEY,primary_customer_id TEXT NOT NULL,duplicate_customer_id TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,summary_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,completed_at INTEGER)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS customer_merge_completed_pair_idx ON customer_merge_runs(primary_customer_id,duplicate_customer_id,status)"),
  ]);
}

function grade(score: number) { return score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "D"; }

export async function scoreLead(db: Db, leadId: string) {
  await ensureLeadScoringMergeTables(db);
  const lead = await db.prepare("SELECT * FROM lead_work_items WHERE id=?").bind(leadId).first<Row>();
  if (!lead) throw new Error("Lead not found");
  const customerId = text(lead.customer_id), now = Date.now();
  const contact = (await db.prepare("SELECT name,primary_phone,email,pet_names,pet_summary,area FROM crm_contacts WHERE id=?").bind(customerId).first<Row>().catch(() => null)) || {};
  const canonical = (await db.prepare("SELECT name,primary_phone,email,city_id FROM canonical_customers WHERE id=?").bind(customerId).first<Row>().catch(() => null)) || {};
  const attempts = Number((await db.prepare("SELECT COUNT(*) count FROM lead_attempts WHERE lead_id=?").bind(leadId).first<Row>().catch(() => null))?.count ?? 0);
  const activities = Number((await db.prepare("SELECT COUNT(*) count FROM crm_activities WHERE contact_id=?").bind(customerId).first<Row>().catch(() => null))?.count ?? 0);
  const messages = Number((await db.prepare("SELECT COUNT(*) count FROM communication_messages WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null))?.count ?? 0);
  const bookings = await db.prepare("SELECT COUNT(*) count,COALESCE(SUM(total_amount),0) value,MAX(created_at) latest FROM canonical_bookings WHERE customer_id=? AND status NOT IN ('cancelled','draft')").bind(customerId).first<Row>().catch(() => null);
  const engagement = clamp(Math.min(40, attempts * 6 + activities * 3 + messages * 2) * 2.5);
  const profileFields = [canonical.name || contact.name, canonical.primary_phone || contact.primary_phone, canonical.email || contact.email, canonical.city_id || contact.area, contact.pet_names, contact.pet_summary];
  const profile = clamp((profileFields.filter(Boolean).length / profileFields.length) * 100);
  const lastSignal = Math.max(Number(lead.updated_at ?? 0), Number(bookings?.latest ?? 0), Number(lead.first_action_at ?? 0));
  const ageDays = Math.max(0, (now - lastSignal) / 86400000);
  const recency = clamp(ageDays <= 1 ? 100 : ageDays <= 3 ? 85 : ageDays <= 7 ? 70 : ageDays <= 14 ? 50 : ageDays <= 30 ? 30 : 10);
  const service = text(lead.service).toLowerCase();
  const serviceWeight = /training|boarding|sitting|grooming/.test(service) ? 65 : /taxi|walking|food/.test(service) ? 45 : 35;
  const historicalValue = Math.min(100, Number(bookings?.value ?? 0) / 250);
  const value = clamp(serviceWeight * 0.65 + historicalValue * 0.35);
  const total = clamp(engagement * 0.30 + profile * 0.20 + recency * 0.30 + value * 0.20);
  const factors = { attempts, activities, messages, ageDays: Math.round(ageDays * 10) / 10, bookingCount: Number(bookings?.count ?? 0), historicalValue: Number(bookings?.value ?? 0), service };
  await db.prepare("INSERT INTO lead_scores (lead_id,engagement_score,profile_score,recency_score,value_score,total_score,grade,factors_json,computed_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET engagement_score=excluded.engagement_score,profile_score=excluded.profile_score,recency_score=excluded.recency_score,value_score=excluded.value_score,total_score=excluded.total_score,grade=excluded.grade,factors_json=excluded.factors_json,computed_at=excluded.computed_at")
    .bind(leadId, engagement, profile, recency, value, total, grade(total), JSON.stringify(factors), now).run();
  return { leadId, engagementScore: engagement, profileScore: profile, recencyScore: recency, valueScore: value, totalScore: total, grade: grade(total), factors };
}

export async function refreshLeadScores(db: Db, limit = 300) {
  await ensureLeadScoringMergeTables(db);
  if (!(await tableExists(db, "lead_work_items"))) return { processed: 0, skipped: true };
  const open = rows(await db.prepare("SELECT id FROM lead_work_items WHERE status NOT IN ('closed','merged') ORDER BY updated_at DESC LIMIT ?").bind(Math.max(1, Math.min(1000, limit))).all<Row>());
  for (const lead of open) await scoreLead(db, text(lead.id));
  return { processed: open.length, skipped: false };
}

async function updateIfExists(db: Db, table: string, sql: string, bindings: unknown[]) {
  if (!(await tableExists(db, table))) return 0;
  const result = await db.prepare(sql).bind(...bindings).run();
  return Number(result.meta?.changes ?? 0);
}

export async function executeCustomerMerge(db: Db, input: { primaryCustomerId: string; duplicateCustomerId: string; actorId: string; reason: string }) {
  await ensureLeadScoringMergeTables(db);
  if (input.primaryCustomerId === input.duplicateCustomerId) throw new Error("Primary and duplicate customers must differ");
  if (text(input.reason).length < 8) throw new Error("A clear merge reason is required");
  const primary = await db.prepare("SELECT * FROM canonical_customers WHERE id=?").bind(input.primaryCustomerId).first<Row>();
  const duplicate = await db.prepare("SELECT * FROM canonical_customers WHERE id=?").bind(input.duplicateCustomerId).first<Row>();
  if (!primary || !duplicate) throw new Error("Both canonical customer records are required for merge");
  const review = await db.prepare("SELECT * FROM customer_merge_reviews WHERE ((primary_customer_id=? AND duplicate_customer_id=?) OR (primary_customer_id=? AND duplicate_customer_id=?)) AND status='open' LIMIT 1")
    .bind(input.primaryCustomerId, input.duplicateCustomerId, input.duplicateCustomerId, input.primaryCustomerId).first<Row>().catch(() => null);
  if (!review) throw new Error("An open duplicate review is required before transactional merge");
  const runId = uid("MERGE"), now = Date.now();
  await db.prepare("INSERT INTO customer_merge_runs (id,primary_customer_id,duplicate_customer_id,status,reason,actor_id,created_at) VALUES (?,?,?,'running',?,?,?)")
    .bind(runId, input.primaryCustomerId, input.duplicateCustomerId, text(input.reason), input.actorId, now).run();
  try {
    const moved: Record<string, number> = {};
    moved.pets = await updateIfExists(db, "canonical_pets", "UPDATE canonical_pets SET customer_id=? WHERE customer_id=?", [input.primaryCustomerId, input.duplicateCustomerId]);
    moved.bookings = await updateIfExists(db, "canonical_bookings", "UPDATE canonical_bookings SET customer_id=? WHERE customer_id=?", [input.primaryCustomerId, input.duplicateCustomerId]);
    moved.leads = await updateIfExists(db, "lead_work_items", "UPDATE lead_work_items SET customer_id=?,updated_at=? WHERE customer_id=?", [input.primaryCustomerId, now, input.duplicateCustomerId]);
    moved.threads = await updateIfExists(db, "communication_threads", "UPDATE communication_threads SET customer_id=?,updated_at=? WHERE customer_id=?", [input.primaryCustomerId, now, input.duplicateCustomerId]);
    moved.messages = await updateIfExists(db, "communication_messages", "UPDATE communication_messages SET customer_id=? WHERE customer_id=?", [input.primaryCustomerId, input.duplicateCustomerId]);
    moved.tickets = await updateIfExists(db, "customer_experience_tickets", "UPDATE customer_experience_tickets SET customer_id=?,updated_at=? WHERE customer_id=?", [input.primaryCustomerId, now, input.duplicateCustomerId]);
    moved.opportunities = await updateIfExists(db, "crm_opportunities", "UPDATE crm_opportunities SET customer_id=?,updated_at=? WHERE customer_id=?", [input.primaryCustomerId, now, input.duplicateCustomerId]);
    moved.revenueOpportunities = await updateIfExists(db, "canonical_revenue_opportunities", "UPDATE canonical_revenue_opportunities SET customer_id=?,updated_at=? WHERE customer_id=?", [input.primaryCustomerId, now, input.duplicateCustomerId]);
    moved.addresses = await updateIfExists(db, "customer_addresses", "UPDATE customer_addresses SET customer_id=? WHERE customer_id=?", [input.primaryCustomerId, input.duplicateCustomerId]);
    moved.preferences = await updateIfExists(db, "customer_contact_preferences", "DELETE FROM customer_contact_preferences WHERE customer_id=? AND EXISTS (SELECT 1 FROM customer_contact_preferences WHERE customer_id=?)", [input.duplicateCustomerId, input.primaryCustomerId]);
    await updateIfExists(db, "customer_contact_preferences", "UPDATE customer_contact_preferences SET customer_id=? WHERE customer_id=?", [input.primaryCustomerId, input.duplicateCustomerId]);
    await db.prepare("UPDATE canonical_customers SET name=CASE WHEN length(name)>=length(?) THEN name ELSE ? END,secondary_phone=COALESCE(secondary_phone,?),email=COALESCE(email,?),updated_at=? WHERE id=?")
      .bind(text(duplicate.name), text(duplicate.name), duplicate.secondary_phone || null, duplicate.email || null, now, input.primaryCustomerId).run();
    if (await tableExists(db, "crm_contacts")) {
      await db.prepare("UPDATE crm_contacts SET stage='Merged',next_action=?,updated_at=? WHERE id=?").bind(`Merged into ${input.primaryCustomerId}`, now, input.duplicateCustomerId).run().catch(() => undefined);
    }
    await db.prepare("UPDATE customer_merge_reviews SET status='merged',reviewed_by=?,reviewed_at=? WHERE id=?").bind(input.actorId, now, review.id).run();
    const summary = { moved, duplicateCustomerId: input.duplicateCustomerId, primaryCustomerId: input.primaryCustomerId };
    await db.prepare("UPDATE customer_merge_runs SET status='completed',summary_json=?,completed_at=? WHERE id=?").bind(JSON.stringify(summary), now, runId).run();
    return { runId, status: "completed", ...summary };
  } catch (error) {
    await db.prepare("UPDATE customer_merge_runs SET status='failed',summary_json=?,completed_at=? WHERE id=?").bind(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), Date.now(), runId).run();
    throw error;
  }
}
