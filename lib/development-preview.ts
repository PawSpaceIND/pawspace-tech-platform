/**
 * The ONE definition of "this request is a local development preview". [PTJA-W3C]
 *
 * WHY THIS FILE EXISTS. The rule was written three times - lib/server-auth.ts, lib/api-gateway.ts and
 * app/api/launch-readiness/route.ts - and only ONE of the three carried the environment guard. The
 * other two granted a preview identity on the Host header alone, and unlike the guarded copy they
 * survive a production build:
 *
 *   api-gateway        -> roleCode "superuser", permissions ["*"], from the OUTER authorization layer
 *   launch-readiness   -> roleCode "superuser" hard-coded for preview@pawspace.test, and its POST
 *                         calls no authorize() at all, so this was its only gate
 *
 * Three copies of an authorization rule is the defect; two of them being wrong is the symptom. Every
 * caller now asks the same function, so a change to the rule cannot apply to some sites and not others.
 *
 * FAIL CLOSED ON ABSENCE. `process` does not exist in a Workers isolate without nodejs_compat, and
 * `process.env.NODE_ENV` is frequently undefined even with it. The old expression
 * `process.env.NODE_ENV !== "production"` read an ABSENT value as "not production" - permissive on
 * absence, the defect class this whole audit hunts - and would additionally throw a ReferenceError
 * where `process` is undefined at all. Preview access is now granted only when the environment says so
 * EXPLICITLY: anything else, absent included, is production.
 */

const PREVIEW_HOSTS = ["terminal.local", "localhost", "127.0.0.1"];

/** The declared environment, or "" when nothing says. Never throws, whatever the runtime provides. */
function declaredEnvironment(): string {
  try {
    if (typeof process === "undefined" || !process?.env) return "";
    return String(process.env.NODE_ENV ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True only for a request to a local preview host in an environment that has EXPLICITLY declared
 * itself non-production. An undeclared environment is treated as production.
 */
export function isDevelopmentPreviewRequest(request: Request): boolean {
  const declared = declaredEnvironment();
  if (declared !== "development" && declared !== "test") return false;
  let hostname: string;
  try { hostname = new URL(request.url).hostname; } catch { return false; }
  return PREVIEW_HOSTS.includes(hostname);
}

/** Exported for the inventory guard in tests/ptja-w3c-preview-host-authority.test.mjs. */
export const DEVELOPMENT_PREVIEW_HOSTS = PREVIEW_HOSTS;
