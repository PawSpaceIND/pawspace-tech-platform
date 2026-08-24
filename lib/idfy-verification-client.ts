/**
 * Fail-closed IDfy verification adapter. IDfy is the KYC/verification provider that runs the automatable
 * provider checks (Aadhaar, PAN, address). Gated on IDFY_API_KEY + IDFY_ACCOUNT_ID + IDFY_URL: with any
 * missing it returns connected:false and verifies nothing - so no provider is ever auto-approved until
 * IDfy is deliberately switched on (in isolated staging first), exactly like the Razorpay/Haptik/voice
 * adapters. Non-automatable checks (police, house, pet-proofing) are never sent here - they are photo /
 * physical / agent verifications recorded by a human.
 */

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();

export type IdfyResult =
  | { connected: true; status: "verified" | "manual_review" | "failed"; reference: string; raw?: Record<string, unknown> }
  | { connected: false; reason: string };

export function idfyConfigured(env: Env): boolean {
  return Boolean(val(env, "IDFY_API_KEY") && val(env, "IDFY_ACCOUNT_ID") && val(env, "IDFY_URL"));
}

/** Map an IDfy task status to our tri-state. IDfy typically returns completed/in_progress/failed with a
 * sub-result; anything not clearly a pass/fail routes to human manual review (never a silent approve). */
export function mapStatus(body: Record<string, unknown>): "verified" | "manual_review" | "failed" {
  const status = String(body.status ?? "").toLowerCase();
  const result = String((body.result as Record<string, unknown> | undefined)?.verification_status ?? body.verification_status ?? "").toLowerCase();
  if (status === "failed" || result === "not_verified" || result === "no_match") return "failed";
  if (result === "verified" || result === "match" || result === "source_verified") return "verified";
  return "manual_review";
}

/** Run an automatable check through IDfy. Fail-closed when not configured. */
export async function verifyWithIdfy(env: Env, input: { checkType: string; referenceId: string; payload: Record<string, unknown> }): Promise<IdfyResult> {
  const apiKey = val(env, "IDFY_API_KEY"), accountId = val(env, "IDFY_ACCOUNT_ID"), url = val(env, "IDFY_URL");
  if (!apiKey || !accountId || !url) return { connected: false, reason: "IDfy is not connected (IDFY_API_KEY / IDFY_ACCOUNT_ID / IDFY_URL not configured)" };
  try {
    const response = await fetch(url, { method: "POST", headers: { "api-key": apiKey, "account-id": accountId, "content-type": "application/json" }, body: JSON.stringify({ task_id: input.referenceId, group_id: input.referenceId, checkType: input.checkType, data: input.payload }) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return { connected: false, reason: `IDfy request failed (${response.status}): ${String((body.error as Record<string, unknown> | undefined)?.message || body.message || "request failed")}` };
    const reference = String(body.request_id || body.id || input.referenceId || "").trim();
    return { connected: true, status: mapStatus(body), reference, raw: body };
  } catch (error) {
    return { connected: false, reason: `IDfy request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
