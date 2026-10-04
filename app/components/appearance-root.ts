import { resolveAppearance, type AppearanceRecord, type AppearanceSnapshot } from "./appearance-resolver";
import type { ThemeId } from "../mobile-app/theme-config";
import { DEVELOPMENT_PREVIEW_HOSTS } from "../../lib/development-preview";

/**
 * Root first-paint resolution against the frozen account contract. The database, the backend helper and the trusted
 * origin source are injected so the precedence is testable without the backend. The whole operation is covered by the
 * device fallback: any failure (database acquisition, origin, helper, storage) renders the existing device resolution.
 * The root never writes cookies.
 */
export type RootAppearance = { snapshot: AppearanceSnapshot; recordVersion: number | null; accountAuthoritative: boolean; source: "account" | "device" | "device-fallback"; fallbackReason?: string };
export type ResolveRequestAppearance<Db = unknown> = (db: Db, request: Request, options?: { cookieValue?: unknown; adminDefault?: ThemeId; conciergeAvailable?: boolean }) =>
  Promise<{ record: AppearanceRecord; snapshot: AppearanceSnapshot; recordVersion: number | null; accountAuthoritative: boolean }>;
/**
 * The documented trusted origin is PAWSPACE_PUBLIC_ORIGIN (Workers env, https host only, the same validation the voice
 * specialists use). A forwarded or host header is accepted only for the development preview hosts, never as a public origin.
 */
export function resolveTrustedOrigin(input: { configured?: unknown; host?: string | null }): string | null {
  const configured = typeof input.configured === "string" ? input.configured.trim() : "";
  if (/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(configured)) return configured.toLowerCase();
  const host = (input.host ?? "").trim().toLowerCase();
  const hostname = host.replace(/:\d+$/, "");
  if (hostname && DEVELOPMENT_PREVIEW_HOSTS.includes(hostname) && /^[a-z0-9.-]+(?::\d{1,5})?$/.test(host)) return `http://${host}`;
  return null;
}
/** The origin the root hands to the helper must itself satisfy the trusted grammar (https host, or http on a preview host). */
export function isTrustedOriginValue(origin: unknown): origin is string {
  if (typeof origin !== "string") return false;
  if (resolveTrustedOrigin({ configured: origin }) === origin.toLowerCase()) return true;
  const m = origin.match(/^http:\/\/([a-z0-9.-]+)(?::\d{1,5})?$/i);
  return Boolean(m && DEVELOPMENT_PREVIEW_HOSTS.includes(m[1].toLowerCase()));
}
export async function resolveRootAppearance<Db>(input: {
  cookieValue?: unknown; cookieHeader: string; trustedOrigin: () => Promise<string | null> | string | null; acquireDb: () => Promise<Db>;
  resolveRequestAppearance: ResolveRequestAppearance<Db>; adminDefault?: ThemeId; conciergeAvailable?: boolean;
}): Promise<RootAppearance> {
  const options = { cookieValue: input.cookieValue, ...(input.adminDefault ? { adminDefault: input.adminDefault } : {}), ...(input.conciergeAvailable !== undefined ? { conciergeAvailable: input.conciergeAvailable } : {}) };
  const device = (fallbackReason: string): RootAppearance => ({ snapshot: resolveAppearance(options), recordVersion: null, accountAuthoritative: false, source: "device-fallback", fallbackReason });
  try {
    const origin = await input.trustedOrigin();
    if (!isTrustedOriginValue(origin)) return device("no trusted origin");
    let db: Db;
    try { db = await input.acquireDb(); } catch (error) { return device("database: " + (error instanceof Error ? error.message : String(error))); }
    const request = new Request(new URL("/", origin), { headers: input.cookieHeader ? { cookie: input.cookieHeader } : {} });
    const resolved = await input.resolveRequestAppearance(db, request, options);
    if (!resolved || typeof resolved !== "object" || !resolved.snapshot || typeof resolved.snapshot !== "object") return device("helper returned no snapshot");
    const authoritative = resolved.accountAuthoritative === true && Number.isSafeInteger(resolved.recordVersion) && (resolved.recordVersion as number) > 0;
    return { snapshot: resolved.snapshot, recordVersion: authoritative ? resolved.recordVersion : null, accountAuthoritative: authoritative, source: authoritative ? "account" : "device" };
  } catch (error) { return device(error instanceof Error ? error.message : String(error)); }
}
