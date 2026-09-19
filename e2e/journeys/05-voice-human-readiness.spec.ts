import { test, expect } from "@playwright/test";

const AS_ADMIN = {
  "oai-authenticated-user-email": "e2e.admin@pawspace.test",
  cookie: "pawspace_admin_mfa=e2e-admin-mfa-session-token",
};
test.use({ extraHTTPHeaders: AS_ADMIN });

const gate = {
  mode: "uat",
  enabled: true,
  blockedReason: null,
  uatApproved: true,
  liveApproved: false,
  telephonyCredentialsConfigured: true,
  statusCallbackConfigured: true,
  missingSecretNames: [],
  allowlistSize: 1,
  recordingApproved: false,
  salesOutboundApproved: false,
  truth: {},
};

const useCase = {
  code: "booking_confirmation",
  label: "Booking confirmation",
  purpose: "Confirm booking",
  requiresBooking: true,
  requiresSalesApproval: false,
  maxAttempts: 2,
  availableNow: true,
};

const call = {
  callId: "VOICE-E2E-001",
  state: "requested",
  useCase: useCase.code,
  purpose: useCase.purpose,
  provider: "exotel",
  providerCallId: "EXO-1",
  productionCall: false,
  mode: "uat",
  consentDecision: "granted",
  optOutDecision: "clear",
  quietHoursDecision: "allowed",
  failureReasonClass: null,
  retryOf: null,
  retryAttempt: 0,
  handoffCaseId: null,
  transcriptRef: null,
  phoneLast4: "1234",
  dialed: true,
};

const readiness = {
  gate,
  transport: { provider: "exotel", configured: true, mode: "uat" },
  useCases: [useCase],
  scripts: [{ useCase: useCase.code, active: true, claimsApproved: true, version: 1 }],
  productionCallsPlaced: 0,
  unappliedProviderEvents: 0,
  callsOpenOverAnHour: 0,
};

test("real voice API boundary serves governed readiness and rejects unknown actions safely", async ({ request }) => {
  const readinessResponse = await request.get("/api/voice-outbound");
  expect(readinessResponse.status()).toBe(200);
  const readinessBody = (await readinessResponse.json()) as {
    data?: { gate?: { mode?: string; enabled?: boolean }; transport?: { provider?: string } };
  };
  expect(readinessBody.data?.gate?.mode).toBeTruthy();
  expect(typeof readinessBody.data?.gate?.enabled).toBe("boolean");
  expect(readinessBody.data?.transport?.provider).toBeTruthy();

  const invalidAction = await request.post("/api/voice-outbound", {
    headers: { "content-type": "application/json" },
    data: { action: "e2e_unknown_voice_action" },
  });
  expect(invalidAction.status()).toBeGreaterThanOrEqual(400);
  expect(invalidAction.status()).toBeLessThan(500);

  const policy = await request.post("/api/voice-outbound", {
    headers: { "content-type": "application/json" },
    data: {
      action: "policy_preview",
      useCase: "booking_confirmation",
      phone: "+919999990000",
      cityId: "blr",
      customerId: "E2E-CUS-UI-001",
      bookingId: "E2E-BOOKING-NOT-OWNED",
    },
  });
  expect(policy.status()).toBeLessThan(500);
  if (policy.ok()) {
    const policyBody = (await policy.json()) as {
      data?: { allowed?: boolean; checks?: Array<{ code?: string; passed?: boolean }> };
    };
    expect(typeof policyBody.data?.allowed).toBe("boolean");
    expect(Array.isArray(policyBody.data?.checks)).toBe(true);
  }
});

test("voice operator console exercises every governed control without a live dial", async ({ page }) => {
  const actions: string[] = [];
  let ledger = [call];

  await page.route("**/api/voice-outbound**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (req.method() === "GET") {
      const scope = url.searchParams.get("scope");
      if (scope === "ledger") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: ledger }),
        });
        return;
      }
      if (scope === "audit") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              call: ledger[0],
              transitions: [
                {
                  sequence: 1,
                  from_state: null,
                  to_state: ledger[0].state,
                  reason: "UAT",
                  actor: "e2e",
                  created_at: Date.now(),
                },
              ],
              policyDecisions: [
                {
                  checkCode: "consent",
                  passed: true,
                  detail: "granted",
                  at: Date.now(),
                },
              ],
              providerEvents: [],
              truth: { productionCallExecuted: false },
            },
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: readiness }),
      });
      return;
    }

    const body = req.postDataJSON() as Record<string, unknown>;
    const action = String(body.action ?? "");
    actions.push(action);

    if (action === "policy_preview") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            allowed: true,
            blockedBy: null,
            blockedDetail: null,
            checks: [
              { code: "consent", passed: true, detail: "granted" },
              { code: "allowlist", passed: true, detail: "matched" },
            ],
          },
        }),
      });
      return;
    }

    if (action === "request_call") {
      ledger = [{ ...call, state: "requested" }];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: ledger[0] }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { callId: call.callId, state: "recorded" } }),
    });
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

  expect(actions).toEqual([
    "policy_preview",
    "request_call",
    "handoff",
    "opt_out",
    "retry",
    "cancel",
  ]);
});

test("AI voice UAT invokes browser mic lifecycle and carrier self-test without external providers", async ({ page }) => {
  const actions: string[] = [];

  await page.addInitScript(() => {
    const state = {
      trackStopped: false,
      socketClosed: false,
      audioClosed: false,
      socketMessages: [] as string[],
    };
    Object.defineProperty(window, "__voiceE2E", { configurable: true, value: state });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [
            {
              stop: () => {
                state.trackStopped = true;
              },
            },
          ],
        }),
      },
    });

    class FakeAudioNode {
      gain = { value: 1 };
      onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
      connect() {
        return this;
      }
      disconnect() {
        return undefined;
      }
    }

    class FakeAudioContext {
      sampleRate = 48000;
      currentTime = 0;
      destination = new FakeAudioNode();
      async resume() {
        return undefined;
      }
      createMediaStreamSource() {
        return new FakeAudioNode();
      }
      createScriptProcessor() {
        return new FakeAudioNode();
      }
      createGain() {
        return new FakeAudioNode();
      }
      async close() {
        state.audioClosed = true;
      }
    }

    class FakeWebSocket {
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      binaryType = "blob";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;

      constructor(_url: string) {
        setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.onopen?.();
        }, 0);
      }

      send(payload: string | ArrayBuffer) {
        state.socketMessages.push(typeof payload === "string" ? payload : `binary:${payload.byteLength}`);
      }

      close(code = 1000, reason = "") {
        this.readyState = FakeWebSocket.CLOSED;
        state.socketClosed = true;
        this.onclose?.({ code, reason });
      }
    }

    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeWebSocket });
  });

  await page.route("**/api/voice-outbound**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const scope = url.searchParams.get("scope");

    if (request.method() === "GET" && scope === "ai_self_test") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            mode: "uat",
            approved: true,
            allowlistSize: 1,
            singleRecipient: true,
            telephonyConfigured: true,
            aiBindingConfigured: true,
            reason: null,
            recording: false,
            maxCallSeconds: 120,
          },
        }),
      });
      return;
    }

    if (request.method() === "GET" && scope === "ai_browser_test") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            mode: "uat",
            deployment: "staging",
            approved: true,
            aiBindingConfigured: true,
            signingKeyConfigured: true,
            sampleRate: 16000,
            reason: null,
          },
        }),
      });
      return;
    }

    const body = request.postDataJSON() as Record<string, unknown>;
    const action = String(body.action ?? "");
    actions.push(action);

    if (action === "uat_ai_browser_ticket") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            ticketId: "VOICE-TICKET-E2E",
            wsUrl: "wss://voice-e2e.invalid/session",
            sampleRate: 16000,
            expiresAt: Date.now() + 60_000,
            sessionLimitSeconds: 60,
          },
        }),
      });
      return;
    }

    if (action === "uat_ai_self_test") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            callId: "VOICE-SELFTEST-E2E",
            providerCallId: "EXOTEL-E2E-NOT-SENT",
            providerStatus: "queued",
            phoneLast4: "1234",
            quietHoursBypassed: true,
            recording: false,
            maxCallSeconds: 120,
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "unexpected test action" }),
    });
  });

  await page.goto("/team/voice/ai-test");
  await expect(page.getByRole("heading", { name: "Call me with the AI bot" })).toBeVisible();
  await expect(page.getByText("READY", { exact: true })).toHaveCount(2);

  await page.getByRole("button", { name: "Test via Browser Mic", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop Browser Test", exact: true })).toBeVisible();
  await expect(page.getByText("connected", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Stop Browser Test", exact: true }).click();
  await expect(page.getByText("stopped", { exact: true })).toBeVisible();
  const cleanup = await page.evaluate(() => {
    return (window as unknown as {
      __voiceE2E: {
        trackStopped: boolean;
        socketClosed: boolean;
        audioClosed: boolean;
        socketMessages: string[];
      };
    }).__voiceE2E;
  });
  expect(cleanup.trackStopped).toBe(true);
  expect(cleanup.socketClosed).toBe(true);
  expect(cleanup.audioClosed).toBe(true);
  expect(cleanup.socketMessages).toContain(JSON.stringify({ type: "start" }));
  expect(cleanup.socketMessages).toContain(JSON.stringify({ type: "stop" }));

  await page.getByRole("button", { name: "Call my allow-listed number now", exact: true }).click();
  await expect(page.getByText(/AI self-test VOICE-SELFTEST-E2E started/)).toBeVisible();

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("clear", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clipped / distorted", exact: true }).click();
  await expect(page.getByText("distorted", { exact: true })).toBeVisible();

  expect(actions).toEqual(["uat_ai_browser_ticket", "uat_ai_self_test"]);
});
