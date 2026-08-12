/**
 * Staff-configurable review setup, per service, edited from Control. For each service line, staff
 * design the review questions, choose how many to ask, when to ask (after every service, or once
 * per N sessions), which channels to send on (in-app notification / WhatsApp), the public review
 * links (Google + app), and the public-review reward amounts. Versioned with maker/checker: a
 * config is a draft until a *different* staff member approves it, then it becomes the active config.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const text = (v: unknown) => String(v ?? "").trim();
const TRIGGERS = ["every_service", "every_n_sessions"] as const;
const CHANNELS = ["notification", "whatsapp", "email"] as const;

// Sensible defaults, all overridable per service from Control.
export const DEFAULT_GOOGLE_REVIEW_LINK = "https://g.page/r/CTm50I98sC-REAo/review";
export const DEFAULT_APP_REVIEW_LINK = "https://onelink.to/jyx88z";
export const DEFAULT_SINGLE_REVIEW_DISCOUNT = 250;   // one public review -> Rs.250 coupon
export const DEFAULT_DOUBLE_REVIEW_DISCOUNT = 400;   // both platforms, same order -> Rs.400 flat off next grooming

export async function ensureReviewConfigTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS review_service_configs (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',questions_json TEXT NOT NULL,question_count INTEGER NOT NULL,trigger_type TEXT NOT NULL,trigger_interval INTEGER NOT NULL DEFAULT 1,channels_json TEXT NOT NULL,google_review_link TEXT NOT NULL,app_review_link TEXT NOT NULL,single_review_discount REAL NOT NULL,double_review_discount REAL NOT NULL,created_by TEXT NOT NULL,approved_by TEXT,approval_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(service_code,version))"),
  ]);
}

/** Save a new DRAFT version of a service's review configuration. */
export async function saveReviewConfig(db: Db, input: Row, actor: string) {
  await ensureReviewConfigTables(db);
  const serviceCode = text(input.serviceCode);
  if (!serviceCode) throw new Error("Service code is required");
  const questions = Array.isArray(input.questions) ? (input.questions as unknown[]).map(q => ({ id: text((q as Row).id) || uid("Q").toLowerCase(), text: text((q as Row).text), type: text((q as Row).type) || "stars" })).filter(q => q.text) : [];
  if (!questions.length) throw new Error("At least one review question is required");
  const questionCount = Math.max(1, Math.min(Number(input.questionCount) || questions.length, questions.length));
  const triggerType = TRIGGERS.includes(text(input.triggerType) as typeof TRIGGERS[number]) ? text(input.triggerType) : "every_service";
  const triggerInterval = triggerType === "every_n_sessions" ? Math.max(1, Number(input.triggerInterval) || 1) : 1;
  const channels = Array.isArray(input.channels) ? (input.channels as unknown[]).map(text).filter(c => CHANNELS.includes(c as typeof CHANNELS[number])) : ["notification"];
  if (!channels.length) throw new Error("At least one delivery channel is required");
  const single = Number.isFinite(Number(input.singleReviewDiscount)) ? Number(input.singleReviewDiscount) : DEFAULT_SINGLE_REVIEW_DISCOUNT;
  const dbl = Number.isFinite(Number(input.doubleReviewDiscount)) ? Number(input.doubleReviewDiscount) : DEFAULT_DOUBLE_REVIEW_DISCOUNT;
  if (single < 0 || dbl < 0) throw new Error("Reward amounts cannot be negative");
  const versionRow = await db.prepare("SELECT COALESCE(MAX(version),0)+1 v FROM review_service_configs WHERE service_code=?").bind(serviceCode).first<Row>();
  const id = uid("REVCFG"), now = Date.now();
  await db.prepare("INSERT INTO review_service_configs (id,service_code,version,status,questions_json,question_count,trigger_type,trigger_interval,channels_json,google_review_link,app_review_link,single_review_discount,double_review_discount,created_by,created_at,updated_at) VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, serviceCode, Number(versionRow?.v || 1), JSON.stringify(questions), questionCount, triggerType, triggerInterval, JSON.stringify(channels), text(input.googleReviewLink) || DEFAULT_GOOGLE_REVIEW_LINK, text(input.appReviewLink) || DEFAULT_APP_REVIEW_LINK, single, dbl, actor, now, now).run();
  return { id, serviceCode, version: Number(versionRow?.v || 1), status: "draft", questionCount, triggerType, triggerInterval, channels };
}

/** Approve a draft (maker/checker: a different staff member, with a reference) -> makes it active. */
export async function approveReviewConfig(db: Db, input: { id: string; approvalReference: string; actor: string }) {
  await ensureReviewConfigTables(db);
  const row = await db.prepare("SELECT * FROM review_service_configs WHERE id=?").bind(input.id).first<Row>();
  if (!row) throw new Error("Review config not found");
  if (text(row.status) !== "draft") throw new Error("Only a draft config can be approved");
  if (text(row.created_by) === input.actor) throw new Error("Maker/checker: the author cannot approve their own review config");
  if (!input.approvalReference.trim()) throw new Error("An approval reference is required");
  await db.prepare("UPDATE review_service_configs SET status='superseded',updated_at=? WHERE service_code=? AND status='active'").bind(Date.now(), text(row.service_code)).run();
  await db.prepare("UPDATE review_service_configs SET status='active',approved_by=?,approval_reference=?,updated_at=? WHERE id=?").bind(input.actor, input.approvalReference.trim(), Date.now(), input.id).run();
  return { id: input.id, serviceCode: text(row.service_code), status: "active" };
}

/** The active review configuration for a service (or null if none approved yet). */
export async function getActiveReviewConfig(db: Db, serviceCode: string) {
  await ensureReviewConfigTables(db);
  const row = await db.prepare("SELECT * FROM review_service_configs WHERE service_code=? AND status='active' ORDER BY version DESC LIMIT 1").bind(serviceCode).first<Row>();
  if (!row) return null;
  return {
    id: text(row.id), serviceCode, version: Number(row.version),
    questions: JSON.parse(text(row.questions_json) || "[]"), questionCount: Number(row.question_count),
    triggerType: text(row.trigger_type), triggerInterval: Number(row.trigger_interval),
    channels: JSON.parse(text(row.channels_json) || "[]"),
    googleReviewLink: text(row.google_review_link), appReviewLink: text(row.app_review_link),
    singleReviewDiscount: Number(row.single_review_discount), doubleReviewDiscount: Number(row.double_review_discount),
  };
}

export async function listReviewConfigs(db: Db) {
  await ensureReviewConfigTables(db);
  const rows = await db.prepare("SELECT id,service_code,version,status,question_count,trigger_type,trigger_interval,channels_json,single_review_discount,double_review_discount,created_by,approved_by,updated_at FROM review_service_configs ORDER BY service_code,version DESC").all<Row>();
  return rows.results.map((r: Row) => ({ id: String(r.id), serviceCode: String(r.service_code), version: Number(r.version), status: String(r.status), questionCount: Number(r.question_count), triggerType: String(r.trigger_type), triggerInterval: Number(r.trigger_interval), channels: JSON.parse(String(r.channels_json || "[]")), singleReviewDiscount: Number(r.single_review_discount), doubleReviewDiscount: Number(r.double_review_discount) }));
}
