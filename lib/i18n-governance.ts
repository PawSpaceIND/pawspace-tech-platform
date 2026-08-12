/**
 * App-wide multi-language (i18n) foundation. A governed, data-driven UI message catalog: every UI string
 * is a key, translated per locale, with English as the always-present fallback so nothing ever renders
 * blank. Locale is resolved from an explicit choice → the user's saved preference → the Accept-Language
 * header → English. Translations can be AI-drafted (fail-closed via the shared AI provider adapter) but
 * are DRAFTS a human publishes - the AI never silently ships customer-facing copy.
 *
 * This is the adoption framework: pages migrate their strings to t(key) incrementally against this
 * catalog; the runtime, fallback, locale resolution, preference store and translation workflow are here.
 * Cold-DB safe.
 */

import { requestAiDraft } from "./ai-provider-adapter";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const empty = () => ({ results: [] as Row[] });

export const SUPPORTED_LOCALES = ["en", "hi", "ta", "te", "kn", "ml", "bn", "mr"];
export const DEFAULT_LOCALE = "en";
const LOCALE_NAMES: Record<string, string> = { en: "English", hi: "हिन्दी", ta: "தமிழ்", te: "తెలుగు", kn: "ಕನ್ನಡ", ml: "മലയാളം", bn: "বাংলা", mr: "मराठी" };

// Starter catalog (English source). Pages adopt these keys incrementally; ops add more.
const BASE_MESSAGES: Record<string, string> = {
  "common.book_now": "Book now", "common.cancel": "Cancel", "common.confirm": "Confirm", "common.continue": "Continue", "common.pay": "Pay", "common.retry": "Retry",
  "nav.home": "Home", "nav.bookings": "My bookings", "nav.pets": "My pets", "nav.wallet": "Wallet", "nav.help": "Help",
  "booking.select_service": "Select a service", "booking.select_slot": "Choose a time slot", "booking.payment_pending": "Payment pending", "booking.confirmed": "Booking confirmed",
  "service.grooming": "Grooming", "service.boarding": "Boarding", "service.dog_training": "Training", "service.pet_sitting": "Pet sitting", "service.dog_walking": "Dog walking", "service.pet_taxi": "Pet taxi",
  "wallet.balance": "Wallet balance", "wallet.enhanced_value": "10% extra when used for a booking",
  "error.generic": "Something went wrong. Please try again.", "error.offline": "You appear to be offline.",
};

export function isSupportedLocale(locale: string): boolean { return SUPPORTED_LOCALES.includes(text(locale)); }

/** Resolve the active locale: explicit → saved preference → Accept-Language → default English. */
export function resolveLocale(input: { explicit?: string | null; preferred?: string | null; acceptLanguage?: string | null }): string {
  if (input.explicit && isSupportedLocale(input.explicit)) return text(input.explicit);
  if (input.preferred && isSupportedLocale(input.preferred)) return text(input.preferred);
  for (const part of text(input.acceptLanguage).split(",")) { const code = part.split(";")[0].trim().slice(0, 2).toLowerCase(); if (isSupportedLocale(code)) return code; }
  return DEFAULT_LOCALE;
}

export async function ensureI18nTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS ui_message_catalog (message_key TEXT NOT NULL,locale TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'published',ai_assisted INTEGER NOT NULL DEFAULT 0,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(message_key,locale))"),
    db.prepare("CREATE TABLE IF NOT EXISTS user_locale_preferences (subject_id TEXT PRIMARY KEY,locale TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  ]);
}

export async function seedBaseMessages(db: Db) {
  await ensureI18nTables(db);
  const now = Date.now();
  for (const [key, value] of Object.entries(BASE_MESSAGES)) await db.prepare("INSERT OR IGNORE INTO ui_message_catalog (message_key,locale,text,status,ai_assisted,updated_by,updated_at) VALUES (?,?,?, 'published',0,'system_seed',?)").bind(key, DEFAULT_LOCALE, value, now).run();
}

/** Set/overwrite a translation for a key+locale. Non-English are 'draft' unless explicitly published. */
export async function setTranslation(db: Db, input: { messageKey: string; locale: string; text: string; publish?: boolean; aiAssisted?: boolean; actorId: string }) {
  await ensureI18nTables(db);
  const key = text(input.messageKey), locale = text(input.locale);
  if (!key || !text(input.text)) throw new Error("messageKey and text are required");
  if (!isSupportedLocale(locale)) throw new Error(`Unsupported locale (use one of: ${SUPPORTED_LOCALES.join(", ")})`);
  const status = locale === DEFAULT_LOCALE || input.publish ? "published" : "draft", now = Date.now();
  await db.prepare("INSERT INTO ui_message_catalog (message_key,locale,text,status,ai_assisted,updated_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(message_key,locale) DO UPDATE SET text=excluded.text,status=excluded.status,ai_assisted=excluded.ai_assisted,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(key, locale, text(input.text), status, input.aiAssisted ? 1 : 0, input.actorId, now).run();
  return { messageKey: key, locale, status };
}

export async function publishTranslation(db: Db, input: { messageKey: string; locale: string; actorId: string }) {
  await ensureI18nTables(db);
  const now = Date.now();
  const res = await db.prepare("UPDATE ui_message_catalog SET status='published',updated_by=?,updated_at=? WHERE message_key=? AND locale=?").bind(input.actorId, now, text(input.messageKey), text(input.locale)).run();
  if (Number(res.meta?.changes || 0) === 0) throw new Error("Translation not found");
  return { messageKey: text(input.messageKey), locale: text(input.locale), status: "published" };
}

/** All published messages for a locale, with English filled in for any missing key (never blank). */
export async function resolveMessages(db: Db, input: { locale: string }) {
  await seedBaseMessages(db);
  const locale = isSupportedLocale(input.locale) ? text(input.locale) : DEFAULT_LOCALE;
  const en = await db.prepare("SELECT message_key,text FROM ui_message_catalog WHERE locale='en' AND status='published'").all<Row>().catch(empty);
  const messages: Record<string, string> = {};
  for (const r of en.results) messages[text(r.message_key)] = text(r.text);
  if (locale !== DEFAULT_LOCALE) { const loc = await db.prepare("SELECT message_key,text FROM ui_message_catalog WHERE locale=? AND status='published'").bind(locale).all<Row>().catch(empty); for (const r of loc.results) messages[text(r.message_key)] = text(r.text); }
  return { locale, localeName: LOCALE_NAMES[locale] || locale, messages, fallbackLocale: DEFAULT_LOCALE };
}

/** Single-key lookup with English fallback. */
export async function translate(db: Db, input: { messageKey: string; locale: string }): Promise<string> {
  await ensureI18nTables(db);
  const key = text(input.messageKey), locale = isSupportedLocale(input.locale) ? text(input.locale) : DEFAULT_LOCALE;
  const row = await db.prepare("SELECT text FROM ui_message_catalog WHERE message_key=? AND locale=? AND status='published'").bind(key, locale).first<Row>().catch(() => null);
  if (row) return text(row.text);
  const en = await db.prepare("SELECT text FROM ui_message_catalog WHERE message_key=? AND locale='en' AND status='published'").bind(key).first<Row>().catch(() => null);
  return en ? text(en.text) : key;
}

/** AI-draft translations for keys missing in a locale. Fail-closed (no AI key → nothing drafted).
 * Produces DRAFTS a human reviews + publishes; never auto-publishes customer-facing copy. */
export async function aiTranslateMissing(db: Db, _env: Env, input: { locale: string; limit?: number; actorEmail: string }) {
  await seedBaseMessages(db);
  const locale = text(input.locale);
  if (!isSupportedLocale(locale) || locale === DEFAULT_LOCALE) throw new Error("A supported non-English locale is required");
  const missing = await db.prepare("SELECT e.message_key,e.text FROM ui_message_catalog e LEFT JOIN ui_message_catalog t ON t.message_key=e.message_key AND t.locale=? WHERE e.locale='en' AND e.status='published' AND t.message_key IS NULL LIMIT ?").bind(locale, Math.max(1, Math.min(Number(input.limit) || 50, 200))).all<Row>().catch(empty);
  if (!missing.results.length) return { connected: true, drafted: 0, remaining: 0 };
  let drafted = 0, connected = true;
  for (const r of missing.results) {
    const draft = await requestAiDraft({ systemPrompt: `You are a professional translator for a pet-care app. Translate the UI string into ${LOCALE_NAMES[locale]} (${locale}). Reply with ONLY the translation, no quotes.`, userPrompt: text(r.text), maxTokens: 200 });
    if (!draft.connected) { connected = false; break; }
    await setTranslation(db, { messageKey: text(r.message_key), locale, text: draft.text, publish: false, aiAssisted: true, actorId: input.actorEmail });
    drafted++;
  }
  return { connected, drafted, note: connected ? "AI-drafted translations saved as DRAFT - review and publish before they go live" : "AI provider not connected - no translations drafted (fail-closed)" };
}

export async function setUserLocale(db: Db, input: { subjectId: string; locale: string }) {
  await ensureI18nTables(db);
  if (!isSupportedLocale(input.locale)) throw new Error("Unsupported locale");
  await db.prepare("INSERT INTO user_locale_preferences (subject_id,locale,updated_at) VALUES (?,?,?) ON CONFLICT(subject_id) DO UPDATE SET locale=excluded.locale,updated_at=excluded.updated_at").bind(text(input.subjectId), text(input.locale), Date.now()).run();
  return { subjectId: text(input.subjectId), locale: text(input.locale) };
}

export async function getUserLocale(db: Db, subjectId: string): Promise<string | null> {
  await ensureI18nTables(db);
  const row = await db.prepare("SELECT locale FROM user_locale_preferences WHERE subject_id=?").bind(text(subjectId)).first<Row>().catch(() => null);
  return row ? text(row.locale) : null;
}

/** Coverage per locale (how many published keys vs the English base) - for the i18n admin. */
export async function i18nCoverage(db: Db) {
  await seedBaseMessages(db);
  const base = await db.prepare("SELECT COUNT(*) c FROM ui_message_catalog WHERE locale='en' AND status='published'").first<Row>().catch(() => null);
  const total = Number(base?.c || 0);
  const rows = await db.prepare("SELECT locale,SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) published,SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) draft FROM ui_message_catalog GROUP BY locale").all<Row>().catch(empty);
  const by = new Map(rows.results.map(r => [text(r.locale), r]));
  return { supportedLocales: SUPPORTED_LOCALES, baseKeyCount: total, locales: SUPPORTED_LOCALES.map(l => { const r = by.get(l); const published = Number(r?.published || 0); return { locale: l, name: LOCALE_NAMES[l] || l, published, draft: Number(r?.draft || 0), coveragePct: total ? Math.round((published / total) * 100) : 0 }; }) };
}
