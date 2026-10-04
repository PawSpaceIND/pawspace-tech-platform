import { APPEARANCE_COOKIE, parseAppearanceRecord, resolveAppearance, serializeAppearanceRecord, type AppearanceRecord, type AppearanceSnapshot } from "../app/components/appearance-resolver";
import { CONCIERGE_AVAILABLE, DEFAULT_THEME, isAppearanceMode, isThemeId, type ThemeId } from "../app/mobile-app/theme-config";
import { resolvePlatformSession } from "./platform-session";
import type { IdentitySubjectType } from "./identity-binding";

export type AppearanceSubject = { subjectType: IdentitySubjectType; subjectId: string };
export type AppearanceOptions = { cookieValue?: unknown; adminDefault?: ThemeId; conciergeAvailable?: boolean };
export type AccountAppearance = { record: AppearanceRecord; snapshot: AppearanceSnapshot; recordVersion: number | null; accountAuthoritative: boolean };
export type AppearanceMutation = { action: "set"; record: Pick<AppearanceRecord, "explicit" | "mode">; expectedRecordVersion: number; idempotencyKey: string };
type Row = Record<string, unknown>;
const PREFERENCE_DDL = `CREATE TABLE IF NOT EXISTS appearance_preferences (
 subject_type TEXT NOT NULL CHECK(subject_type IN ('customer','provider')),
 subject_id TEXT NOT NULL CHECK(length(subject_id)>0),
 explicit_theme TEXT CHECK(explicit_theme IS NULL OR explicit_theme IN ('editorial','concierge')),
 assigned_theme TEXT NOT NULL CHECK(assigned_theme IN ('editorial','concierge')),
 mode TEXT NOT NULL DEFAULT 'system' CHECK(mode IN ('light','dark','system')),
 legacy_snapshot TEXT,
 record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version>0),
 updated_at INTEGER NOT NULL,
 updated_from TEXT NOT NULL CHECK(updated_from IN ('client','migration','admin-default')),
 PRIMARY KEY(subject_type,subject_id))`;
const MUTATION_DDL = `CREATE TABLE IF NOT EXISTS appearance_preference_mutations (
 subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_json TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
 record_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(subject_type,subject_id,idempotency_key))`;
const appearanceTablesReady = new WeakSet<object>();
export async function ensureAppearancePreferenceTables(db: D1Database) {
  if (appearanceTablesReady.has(db)) return;
  await db.batch([db.prepare(PREFERENCE_DDL), db.prepare(MUTATION_DDL), db.prepare("CREATE INDEX IF NOT EXISTS appearance_mutations_rate_idx ON appearance_preference_mutations(subject_type,subject_id,created_at)")]);
  appearanceTablesReady.add(db);
}
function refusal(status: number, error: string): never { throw Response.json({ error }, { status, headers: { "cache-control": "no-store" } }); }
function ownedSubject(subject: AppearanceSubject) {
  if (!["customer", "provider"].includes(subject.subjectType) || typeof subject.subjectId !== "string" || !subject.subjectId.trim()) refusal(401, "Verified identity session required");
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
export function validateAppearanceMutation(value: unknown): AppearanceMutation {
  if (!object(value) || Object.keys(value).some(key => !["action", "record", "expectedRecordVersion", "idempotencyKey"].includes(key)) || value.action !== "set" || !object(value.record)) refusal(400, "Invalid appearance request");
  const record = value.record;
  if (Object.keys(record).length !== 2 || Object.keys(record).some(key => !["explicit", "mode"].includes(key)) || !(record.explicit === null || (typeof record.explicit === "string" && isThemeId(record.explicit))) || !(typeof record.mode === "string" && isAppearanceMode(record.mode))) refusal(400, "Invalid appearance record");
  if (!Number.isSafeInteger(value.expectedRecordVersion) || Number(value.expectedRecordVersion) < 1 || typeof value.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value.idempotencyKey)) refusal(400, "Version and idempotency key required");
  return value as unknown as AppearanceMutation;
}
function fromRow(row: Row, options: AppearanceOptions): AccountAppearance {
  // Never normalise corrupt database values: the UI serializer intentionally coerces invalid values.
  const parsed = parseAppearanceRecord(`v1.${row.explicit_theme ?? "-"}.${row.assigned_theme}.${row.mode}.${row.legacy_snapshot ?? "-"}`);
  if (!parsed.record || !Number.isSafeInteger(row.record_version) || Number(row.record_version) < 1) refusal(503, "Account appearance unavailable");
  return { record: parsed.record, snapshot: resolveAppearance({ ...options, cookieValue: serializeAppearanceRecord(parsed.record) }), recordVersion: Number(row.record_version), accountAuthoritative: true };
}
function fallback(options: AppearanceOptions): AccountAppearance {
  const snapshot = resolveAppearance(options);
  const record: AppearanceRecord = { version: "1", explicit: snapshot.explicit, assigned: snapshot.assigned, mode: snapshot.mode, legacy: snapshot.legacy };
  return { record, snapshot, recordVersion: null, accountAuthoritative: false };
}
async function rowFor(db: D1Database, subject: AppearanceSubject) { return db.prepare("SELECT * FROM appearance_preferences WHERE subject_type=? AND subject_id=?").bind(subject.subjectType, subject.subjectId).first<Row>(); }
export async function readAccountAppearance(db: D1Database, subject: AppearanceSubject, options: AppearanceOptions = {}): Promise<AccountAppearance> {
  ownedSubject(subject);
  await ensureAppearancePreferenceTables(db);
  let row = await rowFor(db, subject);
  if (!row) {
    const device = parseAppearanceRecord(options.cookieValue).record;
    const assigned = resolveAppearance({ adminDefault: options.adminDefault ?? DEFAULT_THEME, conciergeAvailable: options.conciergeAvailable ?? CONCIERGE_AVAILABLE });
    await db.prepare("INSERT OR IGNORE INTO appearance_preferences (subject_type,subject_id,explicit_theme,assigned_theme,mode,legacy_snapshot,record_version,updated_at,updated_from) VALUES (?,?,?,?,?,?,1,?,?)")
      .bind(subject.subjectType, subject.subjectId, device?.explicit ?? null, assigned.assigned, device?.mode ?? assigned.mode, device?.legacy ?? null, Date.now(), device ? "migration" : "admin-default").run();
    row = await rowFor(db, subject);
  }
  if (!row) refusal(503, "Account appearance unavailable");
  return fromRow(row, options);
}
export function appearanceCookieValue(request: Request) {
  const tokens = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${APPEARANCE_COOKIE}=`));
  // Ambiguous duplicate cookies are invalid, matching the resolver's safe fallback.
  return tokens.length > 1 ? "invalid-cookie" : tokens[0]?.slice(APPEARANCE_COOKIE.length + 1);
}
/** Root-layout adapter: session failure or unavailable storage keeps the device paint usable, without writing a replacement account. */
export async function resolveRequestAppearance(db: D1Database, request: Request, options: AppearanceOptions = {}): Promise<AccountAppearance> {
  const input = { ...options, cookieValue: options.cookieValue ?? appearanceCookieValue(request) };
  try {
    const session = await resolvePlatformSession(db, request);
    return session ? await readAccountAppearance(db, session, input) : fallback(input);
  } catch { return fallback(input); }
}
export async function mutateAccountAppearance(db: D1Database, subject: AppearanceSubject, raw: unknown, options: AppearanceOptions = {}) {
  ownedSubject(subject);
  const input = validateAppearanceMutation(raw);
  const current = await readAccountAppearance(db, subject, options);
  const requestJson = JSON.stringify({ explicit: input.record.explicit, mode: input.record.mode, expectedRecordVersion: input.expectedRecordVersion });
  const prior = () => db.prepare("SELECT * FROM appearance_preference_mutations WHERE subject_type=? AND subject_id=? AND idempotency_key=?").bind(subject.subjectType, subject.subjectId, input.idempotencyKey).first<Row>();
  const previous = await prior();
  if (previous) {
    if (previous.request_json !== requestJson) refusal(409, "Idempotency key already used for another request");
    return { data: current, duplicatePrevented: true };
  }
  const next = { ...current.record, ...input.record };
  const now = Date.now();
  // D1 batches are transactional. Only the CAS winner can insert a receipt; that receipt gates the update.
  // Both subject columns participate in every read/write; nothing from the payload selects an account.
  const writes = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO appearance_preference_mutations (subject_type,subject_id,idempotency_key,request_json,before_json,after_json,record_version,created_at)
      SELECT subject_type,subject_id,?,?,?, ?,record_version+1,? FROM appearance_preferences
      WHERE subject_type=? AND subject_id=? AND record_version=?
      AND (SELECT count(*) FROM appearance_preference_mutations WHERE subject_type=? AND subject_id=? AND created_at>?)<30`)
      .bind(input.idempotencyKey, requestJson, JSON.stringify(current.record), JSON.stringify(next), now, subject.subjectType, subject.subjectId, input.expectedRecordVersion, subject.subjectType, subject.subjectId, now - 60_000),
    db.prepare(`UPDATE appearance_preferences SET explicit_theme=?,mode=?,record_version=record_version+1,updated_at=?,updated_from='client'
      WHERE subject_type=? AND subject_id=? AND record_version=?
      AND EXISTS (SELECT 1 FROM appearance_preference_mutations WHERE subject_type=? AND subject_id=? AND idempotency_key=? AND request_json=? AND record_version=?)`)
      .bind(input.record.explicit, input.record.mode, now, subject.subjectType, subject.subjectId, input.expectedRecordVersion, subject.subjectType, subject.subjectId, input.idempotencyKey, requestJson, input.expectedRecordVersion + 1),
  ]);
  const receipt = await prior();
  if (!receipt) {
    const count = await db.prepare("SELECT count(*) AS total FROM appearance_preference_mutations WHERE subject_type=? AND subject_id=? AND created_at>?").bind(subject.subjectType, subject.subjectId, now - 60_000).first<{ total: number }>();
    if (Number(count?.total) >= 30) refusal(429, "Too many appearance changes; retry shortly");
    refusal(409, "Appearance changed; read the current version and retry");
  }
  if (receipt.request_json !== requestJson) refusal(409, "Idempotency key already used for another request");
  const after = await rowFor(db, subject);
  if (!after) refusal(503, "Account appearance unavailable");
  return { data: fromRow(after, options), duplicatePrevented: Number(writes[0].meta.changes) === 0 };
}
