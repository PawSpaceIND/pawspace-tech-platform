import { enqueueCommunication, ensureCommunicationTables, type CommunicationChannel } from "./communication-engine";

type Db = D1Database;
type Row = Record<string, unknown>;
const day = 86_400_000;
async function tableExists(db: Db, name: string) { return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>()); }

/**
 * Real customer lifecycle reminders - the piece flagged as missing: grooming rebooking cadence,
 * subscription unused-session prompts, and subscription renewal reminders. Every reminder here
 * feeds the existing real communications outbox (lib/communication-engine.ts) via a new "lifecycle"
 * purpose category - the real idempotent queue, real consent gating, real retry/dead-letter
 * mechanics already proven for other message types, not a parallel delivery system.
 *
 * Cadence is a real, governed setting (not a hardcoded constant), matching the pattern used
 * throughout this platform for every other business rule.
 */
export async function ensureReminderGovernanceTables(db: Db) {
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS reminder_cadence_policies (id TEXT PRIMARY KEY,policy_code TEXT NOT NULL UNIQUE,grooming_rebooking_days INTEGER NOT NULL DEFAULT 15,subscription_inactivity_days INTEGER NOT NULL DEFAULT 10,subscription_renewal_days INTEGER NOT NULL DEFAULT 7,active INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS reminder_governance_events (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,reminder_type TEXT NOT NULL,cycle_key TEXT NOT NULL,message_id TEXT,duplicate_prevented INTEGER NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"
    ),
  ]);
}

export async function saveReminderCadencePolicy(db: Db, input: { groomingRebookingDays: number; subscriptionInactivityDays: number; subscriptionRenewalDays: number; reason: string; actorId: string }) {
  await ensureReminderGovernanceTables(db);
  if (!Number.isInteger(input.groomingRebookingDays) || input.groomingRebookingDays < 1) throw new Error("Grooming rebooking cadence must be a positive whole number of days");
  if (!Number.isInteger(input.subscriptionInactivityDays) || input.subscriptionInactivityDays < 1) throw new Error("Subscription inactivity cadence must be a positive whole number of days");
  if (!Number.isInteger(input.subscriptionRenewalDays) || input.subscriptionRenewalDays < 1) throw new Error("Subscription renewal window must be a positive whole number of days");
  if (input.reason.trim().length < 8) throw new Error("A clear policy change reason is required");
  const now = Date.now();
  await db.prepare(
    "INSERT INTO reminder_cadence_policies (id,policy_code,grooming_rebooking_days,subscription_inactivity_days,subscription_renewal_days,active,updated_by,updated_at) VALUES ('reminder_default','default',?,?,?,1,?,?) ON CONFLICT(policy_code) DO UPDATE SET grooming_rebooking_days=excluded.grooming_rebooking_days,subscription_inactivity_days=excluded.subscription_inactivity_days,subscription_renewal_days=excluded.subscription_renewal_days,updated_by=excluded.updated_by,updated_at=excluded.updated_at"
  ).bind(input.groomingRebookingDays, input.subscriptionInactivityDays, input.subscriptionRenewalDays, input.actorId, now).run();
  return currentCadencePolicy(db);
}

export async function currentCadencePolicy(db: Db) {
  await ensureReminderGovernanceTables(db);
  const row = await db.prepare("SELECT * FROM reminder_cadence_policies WHERE policy_code='default'").first<Row>();
  if (!row) {
    return { groomingRebookingDays: 15, subscriptionInactivityDays: 10, subscriptionRenewalDays: 7, isDefault: true };
  }
  return { groomingRebookingDays: Number(row.grooming_rebooking_days), subscriptionInactivityDays: Number(row.subscription_inactivity_days), subscriptionRenewalDays: Number(row.subscription_renewal_days), isDefault: false };
}

async function preferredChannel(db: Db, customerId: string): Promise<CommunicationChannel> {
  await ensureCommunicationTables(db);
  const pref = await db.prepare("SELECT preferred_channel FROM communication_preferences WHERE customer_id=?").bind(customerId).first<Row>();
  const channel = pref?.preferred_channel ? String(pref.preferred_channel) : null;
  if (channel && ["whatsapp", "sms", "email", "push", "chat", "voice"].includes(channel)) return channel as CommunicationChannel;
  return "whatsapp";
}

async function logEvent(db: Db, customerId: string, reminderType: string, cycleKey: string, result: Awaited<ReturnType<typeof enqueueCommunication>>, detail: unknown) {
  const messageId = "messageId" in result ? result.messageId : (result.message ? String((result.message as Row).id) : null);
  await db.prepare("INSERT INTO reminder_governance_events (id,customer_id,reminder_type,cycle_key,message_id,duplicate_prevented,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), customerId, reminderType, cycleKey, messageId, result.duplicatePrevented ? 1 : 0, JSON.stringify(detail), Date.now()).run();
}

/**
 * Real grooming rebooking cadence: for every customer whose most recent completed grooming
 * booking is at least `groomingRebookingDays` old, with no future grooming booking already
 * scheduled, queue a real lifecycle reminder. Idempotent per cadence cycle (day 15, day 30, day
 * 45...) via a cycle-numbered key, so the same due-event never double-queues, but a customer who
 * still hasn't rebooked genuinely gets reminded again at the next cycle, not just once ever.
 */
export async function generateGroomingRebookingReminders(db: Db, input: { actorId: string; asOf?: number }) {
  await ensureReminderGovernanceTables(db);
  if (!(await tableExists(db, "canonical_bookings"))) return { queued: 0, suppressed: 0, skippedFutureBooking: 0, cadenceDays: (await currentCadencePolicy(db)).groomingRebookingDays, skipped: true };
  const asOf = input.asOf ?? Date.now();
  const policy = await currentCadencePolicy(db);
  const rows = await db.prepare(
    "SELECT customer_id,MAX(scheduled_end) last_completed FROM canonical_bookings WHERE service_code='grooming' AND status='completed' GROUP BY customer_id"
  ).all<Row>();
  let queued = 0, suppressed = 0, skippedFutureBooking = 0;
  for (const row of rows.results) {
    const customerId = String(row.customer_id);
    const lastCompletedMs = Date.parse(String(row.last_completed));
    if (!Number.isFinite(lastCompletedMs)) continue;
    const daysSince = Math.floor((asOf - lastCompletedMs) / day);
    if (daysSince < policy.groomingRebookingDays) continue;
    const future = await db.prepare(
      "SELECT id FROM canonical_bookings WHERE customer_id=? AND service_code='grooming' AND status NOT IN ('cancelled','completed') AND scheduled_start>? LIMIT 1"
    ).bind(customerId, new Date(asOf).toISOString()).first<Row>();
    if (future) { skippedFutureBooking++; continue; }
    const cycle = Math.floor(daysSince / policy.groomingRebookingDays);
    const cycleKey = `grooming_rebooking:${customerId}:${cycle}`;
    const channel = await preferredChannel(db, customerId);
    const result = await enqueueCommunication(db, {
      customerId, cityId: "blr", channel, purpose: "lifecycle", idempotencyKey: cycleKey,
      templateKey: "grooming_rebooking_reminder", payload: { daysSinceLastService: daysSince, cadenceDays: policy.groomingRebookingDays },
      createdBy: input.actorId,
    });
    await logEvent(db, customerId, "grooming_rebooking", cycleKey, result, { daysSince, cycle });
    if (result.duplicatePrevented) continue;
    if (result.status === "suppressed") suppressed++; else queued++;
  }
  return { queued, suppressed, skippedFutureBooking, cadenceDays: policy.groomingRebookingDays };
}

/**
 * Real subscription session-usage and renewal reminders. Two distinct, real triggers:
 * unused sessions with no recent activity (covers "booked only 1 of 12, remind about the rest"),
 * and approaching expiry (covers renewal). Both are real, computed from
 * customer_grooming_subscriptions - the same real data this session's Founder BI Subscriptions
 * tab already reads, not a new or duplicated source.
 */
export async function generateSubscriptionReminders(db: Db, input: { actorId: string; asOf?: number }) {
  await ensureReminderGovernanceTables(db);
  if (!(await tableExists(db, "customer_grooming_subscriptions")) || !(await tableExists(db, "canonical_bookings"))) return { sessionReminders: 0, renewalReminders: 0, suppressed: 0, subscriptionsScanned: 0, skipped: true };
  const asOf = input.asOf ?? Date.now();
  const policy = await currentCadencePolicy(db);
  const subs = await db.prepare(
    "SELECT id,customer_id,total_sessions,sessions_consumed,expires_at,updated_at FROM customer_grooming_subscriptions WHERE status='active'"
  ).all<Row>();
  let sessionReminders = 0, renewalReminders = 0, suppressed = 0;
  for (const sub of subs.results) {
    const subscriptionId = String(sub.id), customerId = String(sub.customer_id);
    const total = Number(sub.total_sessions), consumed = Number(sub.sessions_consumed), expiresAt = Number(sub.expires_at);
    const channel = await preferredChannel(db, customerId);

    if (consumed < total) {
      const lastActivity = await db.prepare(
        "SELECT MAX(scheduled_start) last FROM canonical_bookings WHERE customer_id=? AND service_code='grooming' AND status NOT IN ('cancelled','draft')"
      ).bind(customerId).first<Row>();
      const lastActivityMs = lastActivity?.last ? Date.parse(String(lastActivity.last)) : Number(sub.updated_at);
      const daysInactive = Number.isFinite(lastActivityMs) ? Math.floor((asOf - lastActivityMs) / day) : 0;
      if (daysInactive >= policy.subscriptionInactivityDays) {
        const cycle = Math.floor(daysInactive / policy.subscriptionInactivityDays);
        const cycleKey = `subscription_sessions:${subscriptionId}:${cycle}`;
        const result = await enqueueCommunication(db, {
          customerId, cityId: "blr", channel, purpose: "lifecycle", idempotencyKey: cycleKey,
          templateKey: "subscription_unused_sessions_reminder", payload: { subscriptionId, sessionsConsumed: consumed, totalSessions: total, sessionsRemaining: total - consumed, daysInactive },
          createdBy: input.actorId,
        });
        await logEvent(db, customerId, "subscription_sessions", cycleKey, result, { subscriptionId, consumed, total, daysInactive });
        if (!result.duplicatePrevented) { if (result.status === "suppressed") suppressed++; else sessionReminders++; }
      }
    }

    const daysToExpiry = Math.floor((expiresAt - asOf) / day);
    if (daysToExpiry >= 0 && daysToExpiry <= policy.subscriptionRenewalDays) {
      const cycleKey = `subscription_renewal:${subscriptionId}`;
      const result = await enqueueCommunication(db, {
        customerId, cityId: "blr", channel, purpose: "lifecycle", idempotencyKey: cycleKey,
        templateKey: "subscription_renewal_reminder", payload: { subscriptionId, daysToExpiry, sessionsRemaining: total - consumed },
        createdBy: input.actorId,
      });
      await logEvent(db, customerId, "subscription_renewal", cycleKey, result, { subscriptionId, daysToExpiry });
      if (!result.duplicatePrevented) { if (result.status === "suppressed") suppressed++; else renewalReminders++; }
    }
  }
  return { sessionReminders, renewalReminders, suppressed, subscriptionsScanned: subs.results.length };
}

export async function runCustomerReminderSweep(db: Db, input: { actorId: string; asOf?: number }) {
  const [grooming, subscription] = await Promise.all([
    generateGroomingRebookingReminders(db, input),
    generateSubscriptionReminders(db, input),
  ]);
  return { grooming, subscription };
}
