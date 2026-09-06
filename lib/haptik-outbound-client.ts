/**
 * Fail-closed adapter for triggering Haptik OUTBOUND voice calls. PawSpace decides who to call and
 * calls Haptik's outbound API. The credential is attached only after the configured endpoint has
 * passed the public-HTTPS egress policy; redirects are never followed, which prevents an upstream
 * redirect from carrying the bearer token to another host.
 */

type HEnv = Record<string, unknown>;
export type OutboundTrigger =
  | { connected: true; callRef: string }
  | { connected: false; reason: string };

export const HAPTIK_OUTBOUND_TIMEOUT_MS = 2_500;

function ipv4Octets(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every(part => part >= 0 && part <= 255) ? octets : null;
}

function blockedIpv4(octets: number[]) {
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function blockedHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const ipv4 = ipv4Octets(host);
  if (ipv4) return blockedIpv4(ipv4);
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) {
      const mappedIpv4 = ipv4Octets(mapped[1]);
      return !mappedIpv4 || blockedIpv4(mappedIpv4);
    }
  }
  return false;
}

/** Validate before any Authorization header exists. Exported so security tests can sabotage endpoints. */
export function validateHaptikOutboundUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Haptik outbound endpoint is invalid"); }
  if (url.protocol !== "https:") throw new Error("Haptik outbound endpoint must use HTTPS");
  if (url.username || url.password) throw new Error("Haptik outbound endpoint must not contain credentials");
  if (blockedHostname(url.hostname)) throw new Error("Haptik outbound endpoint is not a public host");
  return url;
}

export function haptikOutboundConfigured(env: HEnv): boolean {
  const key = String(env?.HAPTIK_OUTBOUND_API_KEY || env?.HAPTIK_API_KEY || "").trim();
  const rawUrl = String(env?.HAPTIK_OUTBOUND_URL || "").trim();
  if (!key || !rawUrl) return false;
  try { validateHaptikOutboundUrl(rawUrl); return true; } catch { return false; }
}

export async function triggerHaptikCall(env: HEnv, input: { phone: string; campaign: string; context?: Record<string, unknown> }): Promise<OutboundTrigger> {
  const key = String(env?.HAPTIK_OUTBOUND_API_KEY || env?.HAPTIK_API_KEY || "").trim();
  const rawUrl = String(env?.HAPTIK_OUTBOUND_URL || "").trim();
  if (!key || !rawUrl) return { connected: false, reason: "Haptik outbound is not connected (HAPTIK_OUTBOUND_API_KEY / HAPTIK_OUTBOUND_URL not configured)" };

  let url: URL;
  try { url = validateHaptikOutboundUrl(rawUrl); }
  catch (error) { return { connected: false, reason: error instanceof Error ? error.message : "Haptik outbound endpoint was refused" }; }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Haptik outbound request timed out")), HAPTIK_OUTBOUND_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ phone: input.phone, campaign: input.campaign, context: input.context || {} }),
    });
    if (response.status >= 300 && response.status < 400) return { connected: false, reason: "Haptik outbound redirect was refused" };
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return { connected: false, reason: `Haptik outbound call failed (${response.status}): ${String((body.error as Record<string, unknown> | undefined)?.message || "request failed")}` };
    const callRef = String(body.callId || body.id || body.reference || "").trim();
    return { connected: true, callRef };
  } catch (error) {
    const reason = controller.signal.aborted ? "Haptik outbound request timed out" : `Haptik outbound request failed: ${error instanceof Error ? error.message : String(error)}`;
    return { connected: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}
