/**
 * Fail-closed adapter for triggering Haptik OUTBOUND voice calls (the direction the engagement says
 * is "the client's responsibility"). PawSpace decides who to call and calls Haptik's outbound API.
 * Gated on HAPTIK_OUTBOUND_API_KEY + HAPTIK_OUTBOUND_URL: with either missing it returns
 * connected:false and nothing is dialled - so no customer is ever called until it's deliberately
 * switched on.
 */

type HEnv = Record<string, unknown>;
export type OutboundTrigger =
  | { connected: true; callRef: string }
  | { connected: false; reason: string };

export function haptikOutboundConfigured(env: HEnv): boolean {
  return Boolean(String(env?.HAPTIK_OUTBOUND_API_KEY || env?.HAPTIK_API_KEY || "").trim() && String(env?.HAPTIK_OUTBOUND_URL || "").trim());
}

export async function triggerHaptikCall(env: HEnv, input: { phone: string; campaign: string; context?: Record<string, unknown> }): Promise<OutboundTrigger> {
  const key = String(env?.HAPTIK_OUTBOUND_API_KEY || env?.HAPTIK_API_KEY || "").trim();
  const url = String(env?.HAPTIK_OUTBOUND_URL || "").trim();
  if (!key || !url) return { connected: false, reason: "Haptik outbound is not connected (HAPTIK_OUTBOUND_API_KEY / HAPTIK_OUTBOUND_URL not configured)" };
  try {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ phone: input.phone, campaign: input.campaign, context: input.context || {} }) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return { connected: false, reason: `Haptik outbound call failed (${response.status}): ${String((body.error as Record<string, unknown> | undefined)?.message || "request failed")}` };
    const callRef = String(body.callId || body.id || body.reference || "").trim();
    return { connected: true, callRef };
  } catch (error) {
    return { connected: false, reason: `Haptik outbound request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
