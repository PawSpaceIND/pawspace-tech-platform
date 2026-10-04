import { isAppearanceMode, isThemeId, type AppearanceMode, type ThemeId } from "../mobile-app/theme-config";
import type { AppearanceRecord, AppearanceSnapshot } from "./appearance-resolver";

/**
 * Client side of the frozen account appearance contract (4 Oct 2026). UI glue only: the backend owns the subject,
 * the assigned theme, the legacy metadata, the version and the first-row assignment. This module never sends them.
 * GET first; account writes are enabled only while the account is authoritative with a positive safe record version.
 * 401 keeps the device path, 503 keeps the current snapshot without fallback writes, 409 re-reads the account and
 * re-applies the explicit user intent once with the new version and a new key (bounded, never an overwrite loop).
 */
export const APPEARANCE_API = "/api/appearance";
export type AccountAppearanceData = { record: AppearanceRecord; snapshot: AppearanceSnapshot; recordVersion: number; accountAuthoritative: true };
export type AccountAppearanceRead =
  | { kind: "account"; data: AccountAppearanceData; duplicatePrevented?: boolean }
  | { kind: "device"; status: 401 }
  | { kind: "unavailable"; status: 503 }
  | { kind: "refused"; status: 400 | 403 | 429 | number; message: string }
  | { kind: "error"; message: string };
export type AccountAppearanceIntent = { explicit: ThemeId | null; mode: AppearanceMode };
export type AccountAppearanceWrite = AccountAppearanceRead | { kind: "conflict"; status: 409 };
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/** Identity guard for a multi-request operation: every internal request checks it first and the signal aborts in-flight ones. */
export type SyncGuard = { shouldContinue?: () => boolean; signal?: AbortSignal };
const superseded = (): AccountAppearanceWrite => ({ kind: "error", message: "superseded: identity or navigation changed" });
const live = (guard?: SyncGuard) => !(guard?.signal?.aborted) && (guard?.shouldContinue ? guard.shouldContinue() : true);

const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
/** 8..128 characters from A-Za-z0-9_- (the contract's idempotency key grammar). */
export function createIdempotencyKey(length = 32): string {
  const size = Math.min(128, Math.max(8, Math.floor(length)));
  const bytes = new Uint8Array(size);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256);
  let key = ""; for (const b of bytes) key += KEY_CHARS[b % KEY_CHARS.length];
  return key;
}
export function isIdempotencyKey(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value); }
export function isPositiveRecordVersion(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** Account writes are enabled only by an authoritative read with a positive safe integer version. */
export function accountWritesEnabled(data: unknown): data is AccountAppearanceData {
  if (!data || typeof data !== "object") return false;
  const d = data as Partial<AccountAppearanceData>;
  return d.accountAuthoritative === true && isPositiveRecordVersion(d.recordVersion) && !!d.record && typeof d.record === "object" && !!d.snapshot && typeof d.snapshot === "object";
}
function normalizeIntent(intent: AccountAppearanceIntent): AccountAppearanceIntent | null {
  const explicit = intent.explicit === null ? null : isThemeId(intent.explicit) ? intent.explicit : undefined;
  if (explicit === undefined || !isAppearanceMode(intent.mode)) return null;
  return { explicit, mode: intent.mode };
}
/** The exact POST body of the contract. Subject, assigned and legacy are server-owned and never included. */
export function setBody(intent: AccountAppearanceIntent, expectedRecordVersion: number, idempotencyKey: string) {
  const normalized = normalizeIntent(intent);
  if (!normalized) throw new Error("Invalid appearance intent");
  if (!isPositiveRecordVersion(expectedRecordVersion)) throw new Error("expectedRecordVersion must be a positive integer");
  if (!isIdempotencyKey(idempotencyKey)) throw new Error("idempotencyKey must be 8..128 characters from A-Za-z0-9_-");
  return { action: "set" as const, record: { explicit: normalized.explicit, mode: normalized.mode }, expectedRecordVersion, idempotencyKey };
}
async function classify(response: Response): Promise<AccountAppearanceWrite> {
  let body: { data?: unknown; duplicatePrevented?: boolean; error?: string } = {};
  try { body = await response.json(); } catch { body = {}; }
  if (response.ok) {
    if (!accountWritesEnabled(body.data)) return { kind: "error", message: "Account appearance response is not authoritative" };
    return { kind: "account", data: body.data, duplicatePrevented: body.duplicatePrevented === true };
  }
  if (response.status === 401) return { kind: "device", status: 401 };
  if (response.status === 503) return { kind: "unavailable", status: 503 };
  if (response.status === 409) return { kind: "conflict", status: 409 };
  return { kind: "refused", status: response.status, message: typeof body.error === "string" ? body.error : `Appearance request refused (${response.status})` };
}
/** GET first. Same-origin, credentials carried by the browser; no account data is cached by this module. */
export async function readAccountAppearance(fetchImpl: FetchLike = fetch, guard?: SyncGuard): Promise<AccountAppearanceRead> {
  try {
    if (!live(guard)) return { kind: "error", message: "superseded: identity or navigation changed" };
    const result = await classify(await fetchImpl(APPEARANCE_API, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal: guard?.signal }));
    return result.kind === "conflict" ? { kind: "error", message: "Unexpected 409 on read" } : result;
  } catch (error) { return { kind: "error", message: error instanceof Error ? error.message : String(error) }; }
}
export async function writeAccountAppearance(body: ReturnType<typeof setBody>, fetchImpl: FetchLike = fetch, guard?: SyncGuard): Promise<AccountAppearanceWrite> {
  return classify(await fetchImpl(APPEARANCE_API, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: guard?.signal }));
}
export type SyncOutcome = { result: AccountAppearanceWrite; attempts: Array<{ body: ReturnType<typeof setBody>; outcome: string }> };
/** One CAS attempt with the bounded ambiguous retry: a transport failure retries once with the SAME key and payload; nothing escapes. */
async function attemptWrite(body: ReturnType<typeof setBody>, fetchImpl: FetchLike, attempts: SyncOutcome["attempts"], guard?: SyncGuard): Promise<AccountAppearanceWrite> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!live(guard)) { attempts.push({ body, outcome: "superseded before request" }); return superseded(); }
    try { const result = await writeAccountAppearance(body, fetchImpl, guard); attempts.push({ body, outcome: result.kind }); return result; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); attempts.push({ body, outcome: (attempt ? "ambiguous again: " : "ambiguous, retrying with the same key: ") + message }); if (attempt) return { kind: "error", message }; }
  }
  return { kind: "error", message: "unreachable" };
}
/**
 * Applies one explicit user intent to the account. Every CAS attempt carries the bounded ambiguous retry. A 409 re-reads
 * the authoritative account and re-applies the SAME intent once with the NEW version and a NEW key; a second 409 is
 * returned as a conflict (no overwrite loop). An older successful retry receipt (duplicatePrevented) carries the CURRENT
 * account, which the caller applies as is. Never throws: every outcome is a plain result.
 */
export async function syncAccountAppearance(intent: AccountAppearanceIntent, expectedRecordVersion: number, fetchImpl: FetchLike = fetch, keyFactory: () => string = createIdempotencyKey, guard?: SyncGuard): Promise<SyncOutcome> {
  const attempts: SyncOutcome["attempts"] = [];
  try {
    const first = await attemptWrite(setBody(intent, expectedRecordVersion, keyFactory()), fetchImpl, attempts, guard);
    if (first.kind !== "conflict") return { result: first, attempts };
    const reread = await readAccountAppearance(fetchImpl, guard);
    if (reread.kind !== "account") return { result: reread, attempts };
    if (!live(guard)) { attempts.push({ body: setBody(intent, reread.data.recordVersion, keyFactory()), outcome: "superseded before re-apply" }); return { result: superseded(), attempts }; }
    const second = await attemptWrite(setBody(intent, reread.data.recordVersion, keyFactory()), fetchImpl, attempts, guard);
    return { result: second, attempts };
  } catch (error) { return { result: { kind: "error", message: error instanceof Error ? error.message : String(error) }, attempts }; }
}
/** Account record wins across devices: true when the account record differs from what the device currently shows. */
export function accountDiffersFromDevice(account: AppearanceRecord, device: AppearanceRecord): boolean {
  return account.explicit !== device.explicit || account.assigned !== device.assigned || account.mode !== device.mode || (account.legacy ?? null) !== (device.legacy ?? null);
}
