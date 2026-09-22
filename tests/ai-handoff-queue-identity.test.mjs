/*
 * Owner decision 2026-09-22 (decision 6 of 10) — the handoff queue shows the canonical customer
 * identity, not only a contact id.
 *
 * listAiHandoffQueue returned `customer_id` and nothing else, so a queue row read "UATD-CUS-1-CRM is
 * waiting". A member of staff could not tell whose conversation it was without opening it, and could
 * not open it at all unless that thread happened to appear in the open-conversations list rendered
 * beside it — which a closed or older thread does not. A count of people waiting that you cannot put a
 * name to is not a queue.
 *
 * Every case drives the real read model against a real database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, seedCustomer, inboundMessage, staffActor } from "./helpers/ai-harness.mjs";

installAiHooks();

const handoff = await import("../lib/ai-human-handoff.ts");

/** A customer, a thread, and an escalation waiting on it. */
async function escalated({ customerId, name = null, phone = "9876500044", crmName = null }) {
  const { sqlite, db } = freshAiDb();
  if (name) seedCustomer(sqlite, customerId, name, phone);
  if (crmName) {
    sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT NOT NULL DEFAULT 'New lead',owner TEXT DEFAULT 'Unassigned',source TEXT DEFAULT 'Website',lifetime_value REAL DEFAULT 0,next_action TEXT,opportunity TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
    sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,1,1)").run(customerId, crmName, phone);
  }
  await inboundMessage(sqlite, db, { threadId: "THREAD-Q", customerId, text: "I need a refund", channel: "whatsapp", idempotencyKey: `q-${customerId}` });
  await handoff.requestAiHumanHandoff(db, { actorEmail: "system@test", threadId: "THREAD-Q", customerId, reason: "refund_payment_dispute", confidence: 0.2 });
  return { sqlite, db, queue: async () => (await handoff.listAiHandoffQueue(db, { actor: staffActor })).queue };
}

test("a waiting escalation names the canonical customer", async () => {
  const { queue } = await escalated({ customerId: "CUS-Q1", name: "Rhea Nair" });
  const [entry] = await queue();
  assert.equal(entry.customerName, "Rhea Nair", "staff must be able to read who is waiting");
  assert.equal(entry.identitySource, "canonical_customer");
  assert.equal(entry.customerPhone, "9876500044");
  assert.equal(entry.customerId, "CUS-Q1", "the id stays, so staff can still match the row against CRM and Customer 360");
  assert.equal(entry.threadId, "THREAD-Q", "and the thread it belongs to, so the row is reachable on its own");
});

test("a conversation that only exists as a CRM contact is named, and said to be one", async () => {
  // The seeded ids differ by suffix (UATD-CUS-1 vs UATD-CUS-1-CRM), so a thread can carry an id that
  // canonical_customers has never held. Naming it from crm_contacts beats showing the raw id, but it
  // must not be presented as the canonical identity.
  const { queue } = await escalated({ customerId: "UATD-CUS-1-CRM", crmName: "Vikram Rao" });
  const [entry] = await queue();
  assert.equal(entry.customerName, "Vikram Rao");
  assert.equal(entry.identitySource, "crm_contact", "the screen says which record answered");
});

test("the canonical record wins when both exist", async () => {
  const { queue } = await escalated({ customerId: "CUS-Q2", name: "Canonical Name", crmName: "Stale CRM Name" });
  const [entry] = await queue();
  assert.equal(entry.customerName, "Canonical Name", "canonical_customers is the identity of record");
  assert.equal(entry.identitySource, "canonical_customer");
});

test("a customer with no record anywhere is reported as unresolved, not invented", async () => {
  const { queue } = await escalated({ customerId: "CUS-NOBODY" });
  const [entry] = await queue();
  assert.equal(entry.customerName, null, "no name is better than a made-up one");
  assert.equal(entry.identitySource, "unresolved");
  assert.equal(entry.customerId, "CUS-NOBODY", "and the row is still shown, because someone is still waiting");
});

test("a database with no canonical_customers table still lists who is waiting", async () => {
  // Cold-DB safety: the identity join is a convenience, and losing it must not lose the queue itself.
  const { sqlite, db } = freshAiDb();
  await inboundMessage(sqlite, db, { threadId: "THREAD-COLD", customerId: "CUS-COLD", text: "help", channel: "whatsapp", idempotencyKey: "cold-1" });
  await handoff.requestAiHumanHandoff(db, { actorEmail: "system@test", threadId: "THREAD-COLD", customerId: "CUS-COLD", reason: "refund_payment_dispute", confidence: 0.2 });
  sqlite.exec("DROP TABLE IF EXISTS canonical_customers");
  sqlite.exec("DROP TABLE IF EXISTS crm_contacts");

  const result = await handoff.listAiHandoffQueue(db, { actor: staffActor });
  assert.equal(result.queue.length, 1, "the escalation is still visible");
  assert.equal(result.queue[0].customerId, "CUS-COLD");
  assert.equal(result.queue[0].customerName, null);
  assert.equal(result.waiting, 1, "and still counted");
});

test("the screen reads the queue's own identity rather than borrowing it from the thread list", async () => {
  // The regression this guards: the queue was consumed only as `queue.find(item => item.threadId ===
  // thread.id)` inside the thread list, so an escalation whose thread was not in that list had no row
  // and no name. The page must render the queue itself.
  const source = (await import("node:fs")).readFileSync(new URL("../app/team/ai/handoff/page.tsx", import.meta.url), "utf8");
  assert.match(source, /queue\.map\(/, "the queue is rendered as its own list");
  assert.match(source, /entry\.customerName/, "and shows the canonical name");
  assert.match(source, /entry\.identitySource/, "and says which record that name came from");
  assert.match(source, /setSelected\(\{ id: entry\.threadId/, "selecting a queued escalation opens that thread directly");
});
