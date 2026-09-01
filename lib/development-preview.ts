/**
 * The ONE definition of "this request is a local development preview". [PTJA-W3C]
 *
 * A request hostname is client-controlled at the HTTP boundary and therefore can never be authority
 * for an authentication-free actor by itself. Preview access is deliberately triple-gated:
 *
 *   1. the runtime explicitly declares development/test;
 *   2. the runtime explicitly enables PAWSPACE_LOCAL_PREVIEW=on;
 *   3. the request uses one of the local preview hostnames.
 *
 * The runtime switch is deployment configuration, not request data, so a remote caller cannot create
 * preview authority by forging Host/X-Forwarded-Host. Absence always fails closed.
 */

const PREVIEW_HOSTS = ["terminal.local", "localhost", "127.0.0.1"];

function envValue(name: string): string {
  try {
    if (typeof process === "undefined" || !process?.env) return "";
    return String(process.env[name] ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True only when local preview is explicitly enabled by runtime configuration. A hostname alone is
 * never sufficient authority, including in a deployed Worker whose Host header can be client supplied.
 */
export function isDevelopmentPreviewRequest(request: Request): boolean {
  // Gate 0, and the reason it exists: scripts/stage-config.mjs SPREADS the built worker's vars into
  // the staging config, and vite.config.ts sets PAWSPACE_LOCAL_PREVIEW:"on" among them. So a deployed
  // staging Worker already satisfies gate 2, and a forged `Host: localhost` satisfies gate 3. Only
  // NODE_ENV being unset stood between a remote caller and an authentication-free actor - safe by
  // OMISSION, on one gate. A declared deployment environment now refuses preview outright, whatever
  // the other three say, so the guarantee no longer depends on a variable happening to be absent.
  if (envValue("PAWSPACE_DEPLOYMENT_ENV")) return false;
  const declared = envValue("NODE_ENV");
  if (declared !== "development" && declared !== "test") return false;
  if (envValue("PAWSPACE_LOCAL_PREVIEW") !== "on") return false;
  let hostname: string;
  try { hostname = new URL(request.url).hostname; } catch { return false; }
  return PREVIEW_HOSTS.includes(hostname);
}

/** Exported for the inventory guard in tests/ptja-w3c-preview-host-authority.test.mjs. */
export const DEVELOPMENT_PREVIEW_HOSTS = PREVIEW_HOSTS;
