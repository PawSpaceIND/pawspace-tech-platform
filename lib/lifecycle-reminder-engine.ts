import { currentCadencePolicy, runCustomerReminderSweep } from "./customer-reminder-governance";

type Db = D1Database;
type Row = Record<string, unknown>;

export const REMINDER_SEGMENTS = ["new_customer", "existing_customer", "subscription", "service"] as const;
export const REMINDER_SERVICES = ["grooming", "training", "boarding", "sitting", "dog_walking", "pet_taxi", "food", "relocation"] as const;

export type ReminderSegment = (typeof REMINDER_SEGMENTS)[number];
export type ReminderService = (typeof REMINDER_SERVICES)[number];

export async function ensureLifecycleReminderTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS lifecycle_reminder_rules (id TEXT PRIMARY KEY,segment TEXT NOT NULL,service_code TEXT,trigger_code TEXT NOT NULL,delay_days INTEGER,repeat_days INTEGER,template_key TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0,configuration_required INTEGER NOT NULL DEFAULT 1,notes TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(segment,service_code,trigger_code))"),
    db.prepare("CREATE TABLE IF NOT EXISTS lifecycle_reminder_rule_events (id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
  ]);
}

async function seedRule(db: Db, input: { id: string; segment: ReminderSegment; serviceCode?: ReminderService | null; triggerCode: string; delayDays?: number | null; repeatDays?: number | null; templateKey: string; active: boolean; configurationRequired: boolean; notes: string }) {
  await db.prepare("INSERT OR IGNORE INTO lifecycle_reminder_rules (id,segment,service_code,trigger_code,delay_days,repeat_days,template_key,active,configuration_required,notes,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(input.id, input.segment, input.serviceCode ?? null, input.triggerCode, input.delayDays ?? null, input.repeatDays ?? null, input.templateKey, input.active ? 1 : 0, input.configurationRequired ? 1 : 0, input.notes, "system:seed", Date.now()).run();
}

export async function ensureLifecycleReminderDefaults(db: Db) {
  await ensureLifecycleReminderTables(db);
  const cadence = await currentCadencePolicy(db);
  await seedRule(db, { id: "rule-grooming-rebook", segment: "service", serviceCode: "grooming", triggerCode: "completed_service_rebook", delayDays: cadence.groomingRebookingDays, repeatDays: cadence.groomingRebookingDays, templateKey: "grooming_rebooking_reminder", active: true, configurationRequired: false, notes: "Existing governed grooming cadence." });
  await seedRule(db, { id: "rule-subscription-unused", segment: "subscription", serviceCode: "grooming", triggerCode: "unused_sessions", delayDays: cadence.subscriptionInactivityDays, repeatDays: cadence.subscriptionInactivityDays, templateKey: "subscription_unused_sessions_reminder", active: true, configurationRequired: false, notes: "Existing governed subscription inactivity cadence." });
  await seedRule(db, { id: "rule-subscription-renewal", segment: "subscription", serviceCode: "grooming", triggerCode: "renewal_window", delayDays: cadence.subscriptionRenewalDays, repeatDays: null, templateKey: "subscription_renewal_reminder", active: true, configurationRequired: false, notes: "Existing governed subscription renewal window." });
  await seedRule(db, { id: "rule-new-customer", segment: "new_customer", triggerCode: "customer_created", delayDays: null, repeatDays: null, templateKey: "new_customer_welcome", active: false, configurationRequired: true, notes: "Business cadence/template must be approved before activation." });
  await seedRule(db, { id: "rule-existing-customer", segment: "existing_customer", triggerCode: "inactive_customer", delayDays: null, repeatDays: null, templateKey: "existing_customer_reengagement", active: false, configurationRequired: true, notes: "Business inactivity threshold must be approved before activation." });
  for (const service of REMINDER_SERVICES.filter((value) => value !== "grooming")) {
    await seedRule(db, { id: `rule-${service}-rebook`, segment: "service", serviceCode: service, triggerCode: "completed_service_rebook", delayDays: null, repeatDays: null, templateKey: `${service}_rebooking_reminder`, active: false, configurationRequired: true, notes: "Service-specific rebooking cadence must be approved before activation." });
  }
}

export async function lifecycleReminderDirectory(db: Db) {
  await ensureLifecycleReminderDefaults(db);
  const rows = await db.prepare("SELECT * FROM lifecycle_reminder_rules ORDER BY segment,service_code,trigger_code").all<Row>();
  const active = rows.results.filter((row) => Number(row.active) === 1).length;
  const configurationRequired = rows.results.filter((row) => Number(row.configuration_required) === 1).length;
  return { rules: rows.results, active, configurationRequired, segments: REMINDER_SEGMENTS, services: REMINDER_SERVICES, deliveryBoundary: "governed_outbox_sandbox" };
}

export async function saveLifecycleReminderRule(db: Db, input: { id: string; delayDays?: number | null; repeatDays?: number | null; templateKey: string; active: boolean; reason: string; actorId: string }) {
  await ensureLifecycleReminderDefaults(db);
  if (input.reason.trim().length < 8) throw new Error("A clear reminder rule change reason is required");
  if (!input.templateKey.trim()) throw new Error("Template key is required");
  for (const [name, value] of [["delayDays", input.delayDays], ["repeatDays", input.repeatDays]] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0)) throw new Error(`${name} must be a non-negative whole number of days`);
  }
  const row = await db.prepare("SELECT * FROM lifecycle_reminder_rules WHERE id=?").bind(input.id).first<Row>();
  if (!row) throw new Error("Reminder rule not found");
  const configurationRequired = input.delayDays == null ? 1 : 0;
  if (input.active && configurationRequired) throw new Error("An active scheduled reminder requires an approved delay/cadence");
  const now = Date.now();
  await db.prepare("UPDATE lifecycle_reminder_rules SET delay_days=?,repeat_days=?,template_key=?,active=?,configuration_required=?,updated_by=?,updated_at=? WHERE id=?")
    .bind(input.delayDays ?? null, input.repeatDays ?? null, input.templateKey.trim(), input.active ? 1 : 0, configurationRequired, input.actorId, now, input.id).run();
  await db.prepare("INSERT INTO lifecycle_reminder_rule_events (id,rule_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), input.id, "rule_saved", input.actorId, JSON.stringify({ reason: input.reason, delayDays: input.delayDays ?? null, repeatDays: input.repeatDays ?? null, active: input.active }), now).run();
  return db.prepare("SELECT * FROM lifecycle_reminder_rules WHERE id=?").bind(input.id).first<Row>();
}

export async function runLifecycleReminderEngine(db: Db, input: { actorId: string; asOf?: number }) {
  await ensureLifecycleReminderDefaults(db);
  const existingGoverned = await runCustomerReminderSweep(db, input);
  const directory = await lifecycleReminderDirectory(db);
  return {
    existingGoverned,
    policySummary: { active: directory.active, configurationRequired: directory.configurationRequired },
    externalDelivery: false,
    note: "New-customer, existing-customer and non-grooming service rules remain inactive until their business cadence/template is explicitly configured.",
  };
}
