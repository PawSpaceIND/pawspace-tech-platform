import { ensureIntegrationReadinessTables, listIntegrationReadiness, updateIntegrationReadiness, integrationLaunchBlockers, syncIntegrationCredentialPresence } from "../lib/integration-readiness";

type Env = { DB: D1Database };

/**
 * Real regression proving the Production Readiness Truth registry's own safety enforcement
 * actually works - not just that the data exists, but that it genuinely cannot be bypassed.
 * This is the CI gate the launch-readiness plan asked for: prevent code from claiming
 * production readiness while a required dependency is sandboxed or unconfigured.
 */
async function runScenario(db: D1Database) {
  await ensureIntegrationReadinessTables(db);

  // Real credential presence detection against a real environment shape - no credentials set,
  // matching this CI environment's genuine state.
  await syncIntegrationCredentialPresence(db, {});
  const afterSync = await listIntegrationReadiness(db, {});
  const razorpay = afterSync.items.find((item) => item.integrationCode === "INT-PAY-01");
  if (!razorpay) throw new Error("Razorpay integration entry must exist in the registry");
  if (razorpay.credentialStatus !== "missing") throw new Error(`Razorpay credentials must be detected as missing with no env configured; got ${razorpay.credentialStatus}`);

  // The registry's own summary.productionReady must be false right now - real, computed, not hardcoded.
  if (afterSync.summary.productionReady !== false) throw new Error("Registry must honestly report productionReady=false while P0 integrations are not controlled_live_verified");

  // Attempting to directly mark an incomplete integration as controlled_live_verified must be
  // genuinely rejected - the safety property under test, not assumed to hold.
  let bypassBlocked = false;
  try {
    await updateIntegrationReadiness(db, {
      integrationCode: "INT-PAY-01",
      changes: { readinessState: "controlled_live_verified" },
      reason: "Attempting to bypass evidence requirements for a CI regression test",
      actorId: "system:ci_regression",
    });
  } catch {
    bypassBlocked = true;
  }
  if (!bypassBlocked) throw new Error("controlled_live_verified must be rejected without real evidence - the safety gate did not hold");

  // A real attempt to smuggle an actual secret value into secret_reference (rather than a
  // reference) must also be rejected.
  let secretLeakBlocked = false;
  try {
    await updateIntegrationReadiness(db, {
      integrationCode: "INT-PAY-01",
      changes: { secretReference: "sk_live_abcdef1234567890" },
      reason: "Attempting to store a real secret value directly in the readiness registry",
      actorId: "system:ci_regression",
    });
  } catch {
    secretLeakBlocked = true;
  }
  if (!secretLeakBlocked) throw new Error("Storing an actual secret value in secret_reference must be rejected, not silently accepted");

  const blockers = await integrationLaunchBlockers(db);
  const razorpayBlocker = blockers.find((b) => b.integrationCode === "INT-PAY-01");
  if (!razorpayBlocker) throw new Error("Razorpay must appear as a real P0 launch blocker while unverified");

  return {
    ok: true,
    assertions: {
      razorpayCredentialStatus: razorpay.credentialStatus,
      registryProductionReady: afterSync.summary.productionReady,
      bypassBlocked,
      secretLeakBlocked,
      razorpayIsLaunchBlocker: Boolean(razorpayBlocker),
    },
  };
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true });
    if (path !== "/run") return new Response("Not found", { status: 404 });
    try {
      return Response.json(await runScenario(env.DB));
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
};
