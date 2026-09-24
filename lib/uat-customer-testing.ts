import { uatLoginEnabled } from "./uat-staging-auth";

/** Fixed synthetic identities, never an arbitrary phone/customer impersonation API. */
export const UAT_CUSTOMER_PERSONAS = [
  { key: "customer-a", id: "UAT-AUDIT-CUSTOMER-A", name: "UAT Audit Customer A", phone: "9000000841" },
  { key: "customer-b", id: "UAT-AUDIT-CUSTOMER-B", name: "UAT Audit Customer B", phone: "9000000842" },
] as const;
export const UAT_CUSTOMER_SOURCE = "uat_audit_fixture";

/** Checked on issuance and use: switching off test access denies existing test sessions too. */
export function uatCustomerTestingEnabled(request: Request, env: Record<string, unknown>): boolean {
  const url = new URL(request.url);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  const isolatedHost = local || (url.hostname === "pawspace-staging.karthik-fce.workers.dev" && url.protocol === "https:");
  const deployment = String(env.PAWSPACE_DEPLOYMENT_ENV || "");
  return isolatedHost
    && String(env.PAWSPACE_UAT_PERSONAS || "") === "on"
    && (deployment === "staging" || (local && deployment === "e2e"))
    && String(env.PAWSPACE_PAYMENT_ENV || "") === "sandbox"
    && String(env.PAWSPACE_PAYMENT_LIVE_APPROVED || "") === "false"
    && String(env.FORBID_PRODUCTION || "") === "true"
    && uatLoginEnabled(env);
}
