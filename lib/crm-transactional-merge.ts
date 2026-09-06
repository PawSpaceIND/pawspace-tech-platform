import { ensureLeadScoringMergeTables } from "./crm-lead-scoring-merge";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
async function tableExists(db: Db, name: string) { return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>()); }

export async function executeTransactionalCustomerMerge(db: Db, input: { primaryCustomerId: string; duplicateCustomerId: string; actorId: string; reason: string }) {
  await ensureLeadScoringMergeTables(db);
  if (input.primaryCustomerId === input.duplicateCustomerId) throw new Error("Primary and duplicate customers must differ");
  if (text(input.reason).length < 8) throw new Error("A clear merge reason is required");
  const [primary, duplicate] = await Promise.all([
    db.prepare("SELECT * FROM canonical_customers WHERE id=?").bind(input.primaryCustomerId).first<Row>(),
    db.prepare("SELECT * FROM canonical_customers WHERE id=?").bind(input.duplicateCustomerId).first<Row>(),
  ]);
  if (!primary || !duplicate) throw new Error("Both canonical customer records are required for merge");
  const review = await db.prepare("SELECT * FROM customer_merge_reviews WHERE ((primary_customer_id=? AND duplicate_customer_id=?) OR (primary_customer_id=? AND duplicate_customer_id=?)) AND status='open' LIMIT 1")
    .bind(input.primaryCustomerId, input.duplicateCustomerId, input.duplicateCustomerId, input.primaryCustomerId).first<Row>().catch(() => null);
  if (!review) throw new Error("An open duplicate review is required before transactional merge");
  // The loser row is soft-merged below (marked, and its phone/email neutralized) so it can never be
  // re-detected as a duplicate of the survivor again. These marker columns must exist first: ALTER cannot
  // run inside the transactional batch, and ADD COLUMN on a column that already exists simply no-ops here.
  for (const ddl of ["ALTER TABLE canonical_customers ADD COLUMN merged_into TEXT", "ALTER TABLE canonical_customers ADD COLUMN merged_at INTEGER"]) await db.prepare(ddl).run().catch(() => undefined);
  const now = Date.now(), runId = uid("MERGE");
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO customer_merge_runs (id,primary_customer_id,duplicate_customer_id,status,reason,actor_id,summary_json,created_at,completed_at) VALUES (?,?,?,'completed',?,?,'{}',?,?)").bind(runId, input.primaryCustomerId, input.duplicateCustomerId, text(input.reason), input.actorId, now, now),
  ];
  if (await tableExists(db, "canonical_pets")) statements.push(db.prepare("UPDATE canonical_pets SET customer_id=? WHERE customer_id=?").bind(input.primaryCustomerId, input.duplicateCustomerId));
  if (await tableExists(db, "canonical_bookings")) statements.push(db.prepare("UPDATE canonical_bookings SET customer_id=? WHERE customer_id=?").bind(input.primaryCustomerId, input.duplicateCustomerId));
  if (await tableExists(db, "lead_work_items")) statements.push(db.prepare("UPDATE lead_work_items SET customer_id=?,updated_at=? WHERE customer_id=?").bind(input.primaryCustomerId, now, input.duplicateCustomerId));
  if (await tableExists(db, "communication_threads")) statements.push(db.prepare("UPDATE communication_threads SET customer_id=?,updated_at=? WHERE customer_id=?").bind(input.primaryCustomerId, now, input.duplicateCustomerId));
  if (await tableExists(db, "communication_messages")) statements.push(db.prepare("UPDATE communication_messages SET customer_id=? WHERE customer_id=?").bind(input.primaryCustomerId, input.duplicateCustomerId));
  if (await tableExists(db, "customer_experience_tickets")) statements.push(db.prepare("UPDATE customer_experience_tickets SET customer_id=?,updated_at=? WHERE customer_id=?").bind(input.primaryCustomerId, now, input.duplicateCustomerId));
  if (await tableExists(db, "crm_opportunities")) statements.push(db.prepare("UPDATE crm_opportunities SET customer_id=?,updated_at=? WHERE customer_id=?").bind(input.primaryCustomerId, now, input.duplicateCustomerId));
  if (await tableExists(db, "canonical_revenue_opportunities")) statements.push(db.prepare("UPDATE canonical_revenue_opportunities SET customer_id=?,updated_at=? WHERE customer_id=?").bind(input.primaryCustomerId, now, input.duplicateCustomerId));
  if (await tableExists(db, "customer_addresses")) statements.push(db.prepare("UPDATE customer_addresses SET customer_id=? WHERE customer_id=?").bind(input.primaryCustomerId, input.duplicateCustomerId));
  if (await tableExists(db, "customer_contact_preferences")) {
    statements.push(db.prepare("DELETE FROM customer_contact_preferences WHERE customer_id=? AND EXISTS (SELECT 1 FROM customer_contact_preferences WHERE customer_id=?)").bind(input.duplicateCustomerId, input.primaryCustomerId));
    statements.push(db.prepare("UPDATE customer_contact_preferences SET customer_id=? WHERE customer_id=?").bind(input.primaryCustomerId, input.duplicateCustomerId));
  }
  if (await tableExists(db, "crm_contacts")) statements.push(db.prepare("UPDATE crm_contacts SET stage='Merged',next_action=?,updated_at=? WHERE id=?").bind(`Merged into ${input.primaryCustomerId}`, now, input.duplicateCustomerId));
  statements.push(
    db.prepare("UPDATE canonical_customers SET name=CASE WHEN length(name)>=length(?) THEN name ELSE ? END,secondary_phone=COALESCE(secondary_phone,?),email=COALESCE(email,?),updated_at=? WHERE id=?").bind(text(duplicate.name), text(duplicate.name), duplicate.secondary_phone || null, duplicate.email || null, now, input.primaryCustomerId),
    // Neutralize the loser: mark it merged and scope its unique identifiers so duplicate detection (which
    // normalizes to the last 10 phone digits and the lowercased email) can never match it against the
    // survivor again. 'MERGED' has no digits, so the normalized phone is empty and is skipped by every
    // detector. Originals are preserved in the merge-run summary for audit and reversal.
    db.prepare("UPDATE canonical_customers SET merged_into=?,merged_at=?,primary_phone='MERGED',secondary_phone=NULL,email=NULL,updated_at=? WHERE id=?").bind(input.primaryCustomerId, now, now, input.duplicateCustomerId),
    db.prepare("UPDATE customer_merge_reviews SET status='merged',reviewed_by=?,reviewed_at=? WHERE id=?").bind(input.actorId, now, review.id),
  );
  // Cloudflare D1 batch() executes the statements as one transactional unit: if any relationship
  // rewrite violates a constraint, none of the merge moves commit.
  const results = await db.batch(statements);
  const changes = results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
  const summary = { primaryCustomerId: input.primaryCustomerId, duplicateCustomerId: input.duplicateCustomerId, statements: statements.length, changes, neutralizedDuplicate: { mergedInto: input.primaryCustomerId, originalPrimaryPhone: text(duplicate.primary_phone), originalSecondaryPhone: duplicate.secondary_phone ? text(duplicate.secondary_phone) : null, originalEmail: duplicate.email ? text(duplicate.email) : null } };
  await db.prepare("UPDATE customer_merge_runs SET summary_json=? WHERE id=?").bind(JSON.stringify(summary), runId).run();
  return { runId, status: "completed", ...summary };
}
