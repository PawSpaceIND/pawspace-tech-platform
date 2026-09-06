/**
 * The ONE definition of "this request is a local development preview". [PTJA-W3C]
 *
 * Preview authority exists only for an explicitly opted-in interactive DEVELOPMENT runtime. Tests
 * must mint real scoped actors/sessions so authorization assertions exercise production trust
 * boundaries; NODE_ENV=test can therefore never receive the preview ["*"] grant.
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

export function isDevelopmentPreviewRequest(request: Request): boolean {
  if (envValue("PAWSPACE_DEPLOYMENT_ENV")) return false;
  if (envValue("NODE_ENV") !== "development") return false;
  if (envValue("PAWSPACE_LOCAL_PREVIEW") !== "on") return false;
  let hostname: string;
  try { hostname = new URL(request.url).hostname; } catch { return false; }
  return PREVIEW_HOSTS.includes(hostname);
}

export const DEVELOPMENT_PREVIEW_HOSTS = PREVIEW_HOSTS;
