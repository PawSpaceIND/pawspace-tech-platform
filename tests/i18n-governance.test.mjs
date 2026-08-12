import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const lib = await read("../lib/i18n-governance.ts");
const route = await read("../app/api/i18n/route.ts");

test("i18n foundation: locales, English fallback, draft/publish workflow", () => {
  assert.match(lib, /SUPPORTED_LOCALES = \["en", "hi", "ta", "te", "kn", "ml", "bn", "mr"\]/);
  assert.match(lib, /export function resolveLocale/);
  // English always fills missing keys (never blank)
  assert.match(lib, /for \(const r of en\.results\) messages\[text\(r\.message_key\)\] = text\(r\.text\)/);
  // non-English translations are draft until published
  assert.match(lib, /locale === DEFAULT_LOCALE \|\| input\.publish \? "published" : "draft"/);
  assert.match(lib, /export async function publishTranslation/);
});

test("AI translation is fail-closed and produces drafts only (never auto-publishes)", () => {
  assert.match(lib, /export async function aiTranslateMissing/);
  assert.match(lib, /requestAiDraft/);
  assert.match(lib, /if \(!draft\.connected\) \{ connected = false; break; \}/);
  // AI drafts are saved unpublished
  assert.match(lib, /publish: false, aiAssisted: true/);
});

test("the i18n route serves messages to any authenticated user and gates admin actions", () => {
  assert.match(route, /export async function GET/);
  assert.match(route, /resolveMessages/);
  // admin/management actions require settings.manage; set_user_locale is self-service
  assert.match(route, /action==="set_user_locale"/);
  assert.match(route, /requirePermission\(actor,"settings\.manage"\)/);
  for (const a of ["set_translation", "publish", "ai_translate"]) assert.match(route, new RegExp(`action==="${a}"`));
});
