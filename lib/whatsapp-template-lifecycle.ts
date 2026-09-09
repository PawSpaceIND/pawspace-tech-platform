import { ensureWhatsAppUatTables } from "./whatsapp-uat-adapter";

type Row = Record<string, unknown>;
export const whatsappTemplateStatuses = ["draft", "submitted", "approved", "rejected", "paused"] as const;
export const whatsappTemplateCategories = ["utility", "authentication", "marketing"] as const;
export type WhatsAppTemplateStatus = (typeof whatsappTemplateStatuses)[number];
export type WhatsAppTemplateCategory = (typeof whatsappTemplateCategories)[number];

type DraftInput = {
  templateKey: string;
  displayName: string;
  category: string;
  language: string;
  body: string;
  sampleValues?: unknown[];
};

const text = (value: unknown) => String(value ?? "").trim();
const parse = <T>(value: unknown, fallback: T): T => {
  try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; }
};
const responseError = (message: string, status = 400): never => { throw new Response(message, { status }); };
const statusOf = (row: Row | null) => text(row?.status) as WhatsAppTemplateStatus;

function variableIndexes(body: string) {
  const matches = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  const unique = [...new Set(matches)].sort((a, b) => a - b);
  if (unique.length > 10) responseError("WhatsApp templates may use at most 10 variables");
  for (let index = 0; index < unique.length; index += 1) {
    if (unique[index] !== index + 1) responseError("Template variables must be sequential from {{1}} with no gaps");
  }
  if (/\{\{[^}]*\}\}/.test(body.replace(/\{\{\d+\}\}/g, ""))) responseError("Template variables must use numeric placeholders such as {{1}}");
  return unique;
}

function normalizeDraft(input: DraftInput) {
  const templateKey = text(input.templateKey).toLowerCase();
  const displayName = text(input.displayName);
  const category = text(input.category).toLowerCase() as WhatsAppTemplateCategory;
  const language = text(input.language);
  const body = text(input.body);
  if (!/^[a-z0-9_]{3,64}$/.test(templateKey)) responseError("Template key must be 3-64 lowercase letters, numbers or underscores");
  if (displayName.length < 2 || displayName.length > 100) responseError("Display name must be 2-100 characters");
  if (!whatsappTemplateCategories.includes(category)) responseError("Category must be utility, authentication or marketing");
  if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(language)) responseError("Language must use a Meta locale such as en or en_US");
  if (body.length < 1 || body.length > 1024) responseError("Template body must be 1-1024 characters");
  const indexes = variableIndexes(body);
  const sampleValues = Array.isArray(input.sampleValues) ? input.sampleValues.map(text) : [];
  if (sampleValues.length !== indexes.length || sampleValues.some((value) => !value || value.length > 128)) {
    responseError(`Provide exactly ${indexes.length} non-empty sample value${indexes.length === 1 ? "" : "s"}, each at most 128 characters`);
  }
  const variables = indexes.map((index) => `{{${index}}}`);
  const renderedBody = indexes.reduce((rendered, index) => rendered.replaceAll(`{{${index}}}`, sampleValues[index - 1]), body);
  return { templateKey, displayName, category, language, body, variables, sampleValues, renderedBody };
}

export async function ensureWhatsAppTemplateLifecycle(db: D1Database) {
  await ensureWhatsAppUatTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_template_lifecycle (template_key TEXT PRIMARY KEY,display_name TEXT NOT NULL,body TEXT NOT NULL,variables_json TEXT NOT NULL DEFAULT '[]',sample_values_json TEXT NOT NULL DEFAULT '[]',meta_reconciliation_status TEXT NOT NULL DEFAULT 'not_submitted',meta_reference TEXT,reconciliation_note TEXT NOT NULL DEFAULT '',submitted_at INTEGER,approved_at INTEGER,rejected_at INTEGER,paused_at INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_template_lifecycle_events (id TEXT PRIMARY KEY,template_key TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,event_type TEXT NOT NULL,actor_email TEXT NOT NULL,reason TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS whatsapp_template_lifecycle_event_idx ON whatsapp_template_lifecycle_events(template_key,created_at)"),
  ]);
}

async function templateRow(db: D1Database, templateKey: string) {
  return db.prepare("SELECT t.*,l.display_name,l.body,l.variables_json,l.sample_values_json,l.meta_reconciliation_status,l.meta_reference,l.reconciliation_note,l.submitted_at,l.approved_at,l.rejected_at,l.paused_at,l.created_by,l.created_at FROM whatsapp_uat_templates t LEFT JOIN whatsapp_template_lifecycle l ON l.template_key=t.template_key WHERE t.template_key=?").bind(templateKey).first<Row>();
}

async function addEvent(db: D1Database, input: { templateKey: string; fromStatus?: string | null; toStatus: string; eventType: string; actorEmail: string; reason: string; detail?: Row; createdAt: number }) {
  await db.prepare("INSERT INTO whatsapp_template_lifecycle_events (id,template_key,from_status,to_status,event_type,actor_email,reason,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(`WATPL-${crypto.randomUUID().slice(0, 12).toUpperCase()}`, input.templateKey, input.fromStatus || null, input.toStatus, input.eventType, input.actorEmail, input.reason, JSON.stringify(input.detail || {}), input.createdAt).run();
}

export async function saveWhatsAppTemplateDraft(db: D1Database, input: DraftInput & { actorEmail: string }) {
  await ensureWhatsAppTemplateLifecycle(db);
  const draft = normalizeDraft(input);
  const existing = await db.prepare("SELECT status FROM whatsapp_uat_templates WHERE template_key=?").bind(draft.templateKey).first<Row>();
  const current = statusOf(existing);
  if (existing && !["draft", "rejected"].includes(current)) responseError("Only draft or rejected templates may be edited", 409);
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES (?,'draft',?,?,?,?) ON CONFLICT(template_key) DO UPDATE SET status='draft',category=excluded.category,approved_language=excluded.approved_language,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .bind(draft.templateKey, draft.category, draft.language, input.actorEmail, now),
    db.prepare("INSERT INTO whatsapp_template_lifecycle (template_key,display_name,body,variables_json,sample_values_json,meta_reconciliation_status,meta_reference,reconciliation_note,submitted_at,approved_at,rejected_at,paused_at,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,'not_submitted',NULL,'',NULL,NULL,NULL,NULL,?,?,?,?) ON CONFLICT(template_key) DO UPDATE SET display_name=excluded.display_name,body=excluded.body,variables_json=excluded.variables_json,sample_values_json=excluded.sample_values_json,meta_reconciliation_status='not_submitted',meta_reference=NULL,reconciliation_note='',submitted_at=NULL,approved_at=NULL,rejected_at=NULL,paused_at=NULL,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .bind(draft.templateKey, draft.displayName, draft.body, JSON.stringify(draft.variables), JSON.stringify(draft.sampleValues), input.actorEmail, now, input.actorEmail, now),
  ]);
  await addEvent(db, { templateKey: draft.templateKey, fromStatus: current || null, toStatus: "draft", eventType: existing ? "draft_updated" : "draft_created", actorEmail: input.actorEmail, reason: existing ? "Template draft updated" : "Template draft created", detail: { category: draft.category, language: draft.language, variables: draft.variables, renderedSample: draft.renderedBody, productionDelivery: false }, createdAt: now });
  return { ...(await templateRow(db, draft.templateKey)), samplePayload: { templateKey: draft.templateKey, language: draft.language, values: draft.sampleValues, renderedBody: draft.renderedBody }, productionDelivery: false, environment: "uat" };
}

export async function submitWhatsAppTemplate(db: D1Database, input: { templateKey: string; actorEmail: string; reason: string }) {
  await ensureWhatsAppTemplateLifecycle(db);
  const key = text(input.templateKey).toLowerCase();
  const reason = text(input.reason);
  if (reason.length < 8) responseError("Submission reason must be at least 8 characters");
  const row = await templateRow(db, key);
  if (row === null) throw new Response("Template not found", { status: 404 });
  const current = statusOf(row);
  if (!["draft", "rejected"].includes(current)) responseError("Only draft or rejected templates may be submitted", 409);
  normalizeDraft({ templateKey: key, displayName: text(row.display_name), category: text(row.category), language: text(row.approved_language), body: text(row.body), sampleValues: parse<unknown[]>(row.sample_values_json, []) });
  const now = Date.now();
  // [AUDIT-2026-09-06 ①] Compare-and-swap the authoritative status instead of a blind update: the prior
  // status is pinned in the WHERE clause and exactly one changed row is asserted, so two operators racing
  // the same transition cannot both write. The companion lifecycle projection runs first, gated on the same
  // prior status, so a losing racer's batch is a no-op (both statements match zero rows) before the 409.
  const results = await db.batch([
    db.prepare("UPDATE whatsapp_template_lifecycle SET meta_reconciliation_status='awaiting_meta_reconciliation',meta_reference=NULL,reconciliation_note='',submitted_at=?,approved_at=NULL,rejected_at=NULL,paused_at=NULL,updated_by=?,updated_at=? WHERE template_key=? AND EXISTS (SELECT 1 FROM whatsapp_uat_templates WHERE template_key=? AND status IN ('draft','rejected'))").bind(now, input.actorEmail, now, key, key),
    db.prepare("UPDATE whatsapp_uat_templates SET status='submitted',updated_by=?,updated_at=? WHERE template_key=? AND status IN ('draft','rejected')").bind(input.actorEmail, now, key),
  ]);
  if (Number(results[1]?.meta?.changes || 0) !== 1) responseError("Template state changed before submission; refresh and retry", 409);
  await addEvent(db, { templateKey: key, fromStatus: current, toStatus: "submitted", eventType: "submitted_for_meta_reconciliation", actorEmail: input.actorEmail, reason, detail: { externalMetaMutation: false, reconciliationRequired: true, productionDelivery: false }, createdAt: now });
  return { ...(await templateRow(db, key)), productionDelivery: false, externalMetaMutation: false, environment: "uat" };
}

export async function reconcileWhatsAppTemplate(db: D1Database, input: { templateKey: string; actorEmail: string; outcome: "approved" | "rejected"; metaReference: string; reason: string }) {
  await ensureWhatsAppTemplateLifecycle(db);
  const key = text(input.templateKey).toLowerCase();
  const reason = text(input.reason);
  const metaReference = text(input.metaReference);
  if (reason.length < 8) responseError("Reconciliation reason must be at least 8 characters");
  if (metaReference.length < 4 || metaReference.length > 160) responseError("Meta reconciliation reference must be 4-160 characters");
  if (!["approved", "rejected"].includes(input.outcome)) responseError("Reconciliation outcome must be approved or rejected");
  const row = await templateRow(db, key);
  if (!row) responseError("Template not found", 404);
  const current = statusOf(row);
  if (current !== "submitted") responseError("Only submitted templates may be reconciled", 409);
  const now = Date.now();
  const approved = input.outcome === "approved";
  // [AUDIT-2026-09-06 ①] CAS on the authoritative status (see submitWhatsAppTemplate). Only a template
  // still in 'submitted' may be reconciled; a concurrent reconcile/pause loses the swap and gets a 409.
  const results = await db.batch([
    db.prepare("UPDATE whatsapp_template_lifecycle SET meta_reconciliation_status=?,meta_reference=?,reconciliation_note=?,approved_at=?,rejected_at=?,updated_by=?,updated_at=? WHERE template_key=? AND EXISTS (SELECT 1 FROM whatsapp_uat_templates WHERE template_key=? AND status='submitted')")
      .bind(input.outcome, metaReference, reason, approved ? now : null, approved ? null : now, input.actorEmail, now, key, key),
    db.prepare("UPDATE whatsapp_uat_templates SET status=?,updated_by=?,updated_at=? WHERE template_key=? AND status='submitted'").bind(input.outcome, input.actorEmail, now, key),
  ]);
  if (Number(results[1]?.meta?.changes || 0) !== 1) responseError("Template state changed before reconciliation; refresh and retry", 409);
  await addEvent(db, { templateKey: key, fromStatus: current, toStatus: input.outcome, eventType: `meta_${input.outcome}_reconciled`, actorEmail: input.actorEmail, reason, detail: { metaReference, externalMetaMutation: false, productionDelivery: false }, createdAt: now });
  return { ...(await templateRow(db, key)), productionDelivery: false, externalMetaMutation: false, environment: "uat" };
}

export async function pauseWhatsAppTemplate(db: D1Database, input: { templateKey: string; actorEmail: string; reason: string }) {
  await ensureWhatsAppTemplateLifecycle(db);
  const key = text(input.templateKey).toLowerCase();
  const reason = text(input.reason);
  if (reason.length < 8) responseError("Pause reason must be at least 8 characters");
  const row = await templateRow(db, key);
  if (!row) responseError("Template not found", 404);
  const current = statusOf(row);
  if (current !== "approved") responseError("Only approved templates may be paused", 409);
  const now = Date.now();
  // [AUDIT-2026-09-06 ①] CAS on the authoritative status (see submitWhatsAppTemplate). Only an 'approved'
  // template may be paused; a racing transition loses the swap and gets a 409.
  const results = await db.batch([
    db.prepare("UPDATE whatsapp_template_lifecycle SET meta_reconciliation_status='paused',paused_at=?,reconciliation_note=?,updated_by=?,updated_at=? WHERE template_key=? AND EXISTS (SELECT 1 FROM whatsapp_uat_templates WHERE template_key=? AND status='approved')").bind(now, reason, input.actorEmail, now, key, key),
    db.prepare("UPDATE whatsapp_uat_templates SET status='paused',updated_by=?,updated_at=? WHERE template_key=? AND status='approved'").bind(input.actorEmail, now, key),
  ]);
  if (Number(results[1]?.meta?.changes || 0) !== 1) responseError("Template state changed before pause; refresh and retry", 409);
  await addEvent(db, { templateKey: key, fromStatus: current, toStatus: "paused", eventType: "template_paused", actorEmail: input.actorEmail, reason, detail: { productionDelivery: false }, createdAt: now });
  return { ...(await templateRow(db, key)), productionDelivery: false, environment: "uat" };
}

export async function listWhatsAppTemplateLifecycle(db: D1Database) {
  await ensureWhatsAppTemplateLifecycle(db);
  const templatesResult = await db.prepare("SELECT t.template_key,t.status,t.category,t.approved_language,t.updated_by,t.updated_at,l.display_name,l.body,l.variables_json,l.sample_values_json,l.meta_reconciliation_status,l.meta_reference,l.reconciliation_note,l.submitted_at,l.approved_at,l.rejected_at,l.paused_at,l.created_by,l.created_at FROM whatsapp_uat_templates t LEFT JOIN whatsapp_template_lifecycle l ON l.template_key=t.template_key ORDER BY t.updated_at DESC,t.template_key ASC").all<Row>();
  const usageResult = await db.prepare("SELECT m.template_key,COUNT(*) AS sends,SUM(CASE WHEN m.status IN ('delivered','read') THEN 1 ELSE 0 END) AS delivered,SUM(CASE WHEN EXISTS (SELECT 1 FROM communication_messages r WHERE r.thread_id=m.thread_id AND r.direction='inbound' AND r.channel='whatsapp' AND r.created_at>m.created_at AND r.created_at<=m.created_at+604800000) THEN 1 ELSE 0 END) AS replies,COUNT(DISTINCT COALESCE(m.booking_id,t.booking_id)) AS bookings FROM communication_messages m LEFT JOIN communication_threads t ON t.id=m.thread_id WHERE m.direction='outbound' AND m.channel='whatsapp' AND m.template_key IS NOT NULL GROUP BY m.template_key").all<Row>();
  const eventsResult = await db.prepare("SELECT * FROM whatsapp_template_lifecycle_events ORDER BY created_at DESC LIMIT 100").all<Row>();
  const usage = new Map((usageResult.results || []).map((row) => [text(row.template_key), { sends: Number(row.sends || 0), delivered: Number(row.delivered || 0), replies: Number(row.replies || 0), bookings: Number(row.bookings || 0) }]));
  const templates = (templatesResult.results || []).map((row) => {
    const sampleValues = parse<string[]>(row.sample_values_json, []);
    const body = text(row.body);
    const renderedBody = sampleValues.reduce((rendered, value, index) => rendered.replaceAll(`{{${index + 1}}}`, value), body);
    return { ...row, variables: parse<string[]>(row.variables_json, []), sampleValues, samplePayload: { templateKey: text(row.template_key), language: text(row.approved_language), values: sampleValues, renderedBody }, usage: usage.get(text(row.template_key)) || { sends: 0, delivered: 0, replies: 0, bookings: 0 } };
  });
  return { templates, events: eventsResult.results || [], categories: whatsappTemplateCategories, statuses: whatsappTemplateStatuses, productionDelivery: false, externalMetaMutation: false, environment: "uat" };
}
