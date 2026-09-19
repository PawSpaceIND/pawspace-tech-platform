import { test, expect } from "@playwright/test";

const AS_ADMIN = {
  "oai-authenticated-user-email": "e2e.admin@pawspace.test",
  cookie: "pawspace_admin_mfa=e2e-admin-mfa-session-token",
};
test.use({ extraHTTPHeaders: AS_ADMIN });

const gate = {
  mode: "uat", enabled: true, blockedReason: null, uatApproved: true, liveApproved: false,
  telephonyCredentialsConfigured: true, statusCallbackConfigured: true, missingSecretNames: [],
  allowlistSize: 1, recordingApproved: false, salesOutboundApproved: false, truth: {},
};
const useCase = {
  code: "booking_confirmation", label: "Booking confirmation", purpose: "Confirm booking",
  requiresBooking: true, requiresSalesApproval: false, maxAttempts: 2, availableNow: true,
};
const call = {
  callId: "VOICE-E2E-001", state: "requested", useCase: useCase.code, purpose: useCase.purpose,
  provider: "exotel", providerCallId: "EXO-1", productionCall: false, mode: "uat",
  consentDecision: "granted", optOutDecision: "clear", quietHoursDecision: "allowed",
  failureReasonClass: null, retryOf: null, retryAttempt: 0, handoffCaseId: null,
  transcriptRef: null, phoneLast4: "1234", dialed: true,
};
const readiness = {
  gate, transport: { provider: "exotel", configured: true, mode: "uat" },
  useCases: [useCase], scripts: [{ useCase: useCase.code, active: true, claimsApproved: true, version: 1 }],
  productionCallsPlaced: 0, unappliedProviderEvents: 0, callsOpenOverAnHour: 0,
};

test("voice operator console exercises every governed action without a live dial", async ({ page }) => {
  const actions: string[] = [];
  let ledger = [call];

  await page.route("**/api/voice-outbound**", async route => {
    const req = route.request();
    const url = new URL(req.url());

    if (req.method() === "GET") {
      const scope = url.searchParams.get("scope");
      if (scope === "ledger") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: ledger }) });
        return;
      }
      if (scope === "audit") {
        await route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ data: {
            call: ledger[0], transitions: [{ sequence: 1, from_state: null, to_state: ledger[0].state, reason: "UAT", actor: "e2e", created_at: Date.now() }],
            policyDecisions: [{ checkCode: "consent", passed: true, detail: "granted", at: Date.now() }],
            providerEvents: [], truth: { productionCallExecuted: false },
          }}),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: readiness }) });
      return;
    }

    const body = req.postDataJSON() as Record<string, unknown>;
    const action = String(body.action ?? "");
    actions.push(action);

    if (action === "policy_preview") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        allowed: true, blockedBy: null, blockedDetail: null,
        checks: [{ code: "consent", passed: true, detail: "granted" }, { code: "allowlist", passed: true, detail: "matched" }],
      }})});
      return;
    }

    if (action === "request_call") {
      ledger = [{ ...call, state: "requested" }];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: ledger[0] }) });
      return;
    }

    const state = action === "handoff" ? "handoff_requested" : action === "opt_out" ? "blocked_opt_out" : action === "retry" ? "retry_requested" : action === "cancel" ? "cancelled" : "recorded";
    ledger = [{ ...ledger[0], state }];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { callId: call.callId, state } }) });
  });

  await page.goto("/team/voice");
  await expect(page.getByRole("heading", { name: "Automated outbound calling" })).toBeVisible();
  await expect(page.getByText("ENABLED", { exact: true })).toBeVisible();

  await page.getByLabel("Use case").selectOption(useCase.code);
  await page.getByLabel("Recipient number").fill("+919999991234");
  await page.getByLabel("Customer ID").fill("CUS-E2E");
  await page.getByLabel("Booking ID").fill("BOOK-E2E");

  const dial = page.getByRole("button", { name: "Place call", exact: true });
  await expect(dial).toBeDisabled();
  await page.getByRole("button", { name: "Check policy (no dial)", exact: true }).click();
  await expect(page.getByText("Policy allows this call. Nothing has been dialled.")).toBeVisible();
  await expect(dial).toBeEnabled();
  await dial.click();
  await expect(page.getByText(/Call VOICE-E2E-001 is in state requested/)).toBeVisible();

  await page.getByRole("button", { name: "Refresh", exact: true }).click();

  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page.getByText("Audit · VOICE-E2E-001", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Hand off", exact: true }).click();
  await expect(page.getByText(/handoff on VOICE-E2E-001/)).toBeVisible();

  await page.getByRole("button", { name: "Opt out", exact: true }).click();
  await expect(page.getByText(/opt_out on VOICE-E2E-001/)).toBeVisible();

  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText(/retry on VOICE-E2E-001/)).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText(/cancel on VOICE-E2E-001/)).toBeVisible();

  expect(actions).toEqual(expect.arrayContaining(["policy_preview", "request_call", "handoff", "opt_out", "retry", "cancel"]));
});

test("AI voice UAT page exposes browser-mic and carrier controls with safe readiness truth", async ({ page }) => {
  await page.route("**/api/voice-outbound**", async route => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get("scope");
    if (scope === "ai_self_test") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        enabled: true, mode: "uat", approved: true, allowlistSize: 1, singleRecipient: true,
        telephonyConfigured: true, aiBindingConfigured: true, reason: null, recording: false, maxCallSeconds: 120,
      }})});
      return;
    }
    if (scope === "ai_browser_test") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        enabled: true, mode: "uat", deployment: "staging", approved: true, aiBindingConfigured: true,
        signingKeyConfigured: true, sampleRate: 16000, reason: null,
      }})});
      return;
    }
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unexpected test action" }) });
  });

  await page.goto("/team/voice/ai-test");
  await expect(page.getByRole("heading", { name: "Call me with the AI bot" })).toBeVisible();
  await expect(page.getByText("READY", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Test via Browser Mic", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Call my allow-listed number now", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("clear", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clipped / distorted", exact: true }).click();
  await expect(page.getByText("distorted", { exact: true })).toBeVisible();
});
