import { writeFileSync } from "node:fs";

const BASE = String(process.env.STAGING_URL || "https://pawspace-staging.karthik-fce.workers.dev").replace(/\/$/, "");
const ACCESS_CODE = String(process.env.PAWSPACE_UAT_ACCESS_CODE || "").trim();
const FOUNDER_EMAIL = "founder@pawspace.in";
const CUSTOMER = { phone: "9999999998", name: "UAT Customer", cityId: "blr" };

if (!ACCESS_CODE) {
  console.error("PAWSPACE_UAT_ACCESS_CODE is required for the founder configuration check.");
  process.exit(1);
}

const fail = (message, detail = {}) => {
  console.error(`FAIL: ${message}`);
  if (Object.keys(detail).length) console.error(JSON.stringify(detail));
  process.exit(1);
};

async function request(method, path, { cookie = "", body } = {}) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const raw = await response.text();
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch {}
  return { response, status: response.status, body: parsed, raw };
}

function sessionCookie(result) {
  const value = String(result.response.headers.get("set-cookie") || "");
  return value.split(";")[0];
}

async function founderSession() {
  const login = await request("POST", "/api/staging-login", {
    body: { action: "login", code: ACCESS_CODE, email: FOUNDER_EMAIL },
  });
  const cookie = sessionCookie(login);
  if (login.status < 200 || login.status >= 400 || !cookie) {
    fail("Founder staging sign-in failed", { status: login.status });
  }
  return cookie;
}

async function ensureAiReady(cookie) {
  let status = await request("GET", "/api/ai-business-configuration?mode=status", { cookie });
  if (status.status !== 200) fail("AI configuration status could not be read", { status: status.status });

  if (status.body?.data?.configurationRequired === true) {
    const seeded = await request("POST", "/api/ai-bootstrap", { cookie, body: {} });
    if (seeded.status < 200 || seeded.status >= 300) {
      fail("Starter AI grounding could not be installed", { status: seeded.status });
    }
  }

  status = await request("GET", "/api/ai-business-configuration?mode=status", { cookie });
  if (status.status !== 200) fail("AI configuration status could not be re-read", { status: status.status });

  if (status.body?.data?.rollout?.customersEnabled !== true) {
    const rollout = await request("POST", "/api/ai-rollout", {
      cookie,
      body: { stage: "customers", reason: "UAT-only live V2 Chat AI certification approved by owner on 2026-09-25" },
    });
    if (rollout.status < 200 || rollout.status >= 300) {
      fail("Customer AI rollout could not be enabled for staging", { status: rollout.status });
    }
  }

  status = await request("GET", "/api/ai-business-configuration?mode=status", { cookie });
  if (status.status !== 200) fail("Final AI configuration status could not be read", { status: status.status });

  const data = status.body?.data || {};
  if (data.provider?.connected !== true) {
    fail("OpenAI provider is not connected", { reason: data.provider?.reason || "unknown" });
  }
  if (data.provider?.providerRef !== "openai") {
    fail("Staging is not using OpenAI", { providerRef: data.provider?.providerRef || "unknown" });
  }
  if (data.configurationRequired === true) fail("AI grounding is still incomplete");
  if (data.rollout?.customersEnabled !== true) fail("Customer rollout is still not active on staging");
  if (Array.isArray(data.killSwitches) && data.killSwitches.length) {
    fail("An AI kill switch is active; certification will not override a safety control", { count: data.killSwitches.length });
  }

  return {
    provider: data.provider?.providerRef,
    model: data.provider?.modelRef || null,
    customersEnabled: data.rollout?.customersEnabled === true,
    activeKnowledge: Number(data.activeKnowledge || 0),
    activeIntents: Number(data.activeIntents || 0),
  };
}

async function customerSession() {
  const requested = await request("POST", "/api/customer-otp", {
    body: { action: "request", phone: CUSTOMER.phone },
  });
  const challengeId = String(requested.body?.data?.challengeId || "");
  const sandboxCode = String(requested.body?.data?.sandboxCode || "");
  if (
    requested.status < 200 || requested.status >= 300 ||
    requested.body?.data?.sandboxDelivery !== true ||
    requested.body?.data?.liveSmsDelivered !== false ||
    !challengeId || !sandboxCode
  ) {
    fail("Sandbox customer OTP request did not return the UAT-only proof", { status: requested.status });
  }

  const verified = await request("POST", "/api/customer-otp", {
    body: {
      action: "verify",
      challengeId,
      code: sandboxCode,
      name: CUSTOMER.name,
      cityId: CUSTOMER.cityId,
    },
  });
  const cookie = sessionCookie(verified);
  if (verified.status < 200 || verified.status >= 300 || !cookie) {
    fail("Sandbox customer OTP verification failed", { status: verified.status });
  }

  const identity = await request("GET", "/api/identity-session", { cookie });
  if (identity.status !== 200 || identity.body?.data?.subjectType !== "customer") {
    fail("Verified sandbox session did not resolve to a customer", { status: identity.status });
  }
  return cookie;
}

async function ask(cookie, message) {
  const result = await request("POST", "/api/ai-web-chat", {
    cookie,
    body: {
      mode: "authenticated",
      message,
      idempotencyKey: `staging-ai-cert-${crypto.randomUUID()}`,
    },
  });
  if (result.status !== 200) fail("Authenticated V2 AI chat call failed", { status: result.status });
  const data = result.body?.data || {};
  const turn = data.ai?.turn || {};
  if (!String(turn.output || "").trim()) {
    fail("V2 AI returned no customer-visible output", { outcome: turn.outcome || null, handoffReason: turn.handoffReason || null });
  }
  if (data.ai?.providerConnected !== true) {
    fail("V2 AI did not complete through a healthy provider", {
      outcome: turn.outcome || null,
      handoffReason: turn.handoffReason || null,
      provider: turn.provider || null,
    });
  }
  if (turn.provider !== "openai") {
    fail("V2 AI reply did not come from OpenAI", { provider: turn.provider || null, modelRef: turn.modelRef || null });
  }
  if (!["draft_review_required", "reply_ready"].includes(String(turn.outcome || ""))) {
    fail("V2 AI conversation did not finish with a model-backed reply", {
      outcome: turn.outcome || null,
      handoffReason: turn.handoffReason || null,
    });
  }
  return {
    threadId: String(data.threadId || turn.threadId || ""),
    provider: turn.provider,
    modelRef: turn.modelRef || null,
    outcome: turn.outcome,
    outputChars: String(turn.output).length,
  };
}

const founderCookie = await founderSession();
const readiness = await ensureAiReady(founderCookie);
const customerCookie = await customerSession();

const first = await ask(customerCookie, "What PawSpace services can I book for my dog?");
const second = await ask(customerCookie, "Which of those services can happen at my home?");

if (!first.threadId || second.threadId !== first.threadId) {
  fail("The second V2 AI turn did not continue on the same customer conversation", {
    firstThreadPresent: Boolean(first.threadId),
    sameThread: second.threadId === first.threadId,
  });
}

const evidence = {
  ok: true,
  certifiedAt: new Date().toISOString(),
  stagingOrigin: BASE,
  provider: first.provider,
  modelRef: first.modelRef,
  customerRollout: readiness.customersEnabled,
  activeKnowledge: readiness.activeKnowledge,
  activeIntents: readiness.activeIntents,
  firstTurn: { outcome: first.outcome, outputChars: first.outputChars },
  secondTurn: { outcome: second.outcome, outputChars: second.outputChars },
  sameThread: true,
  secretValuesRecorded: false,
};

writeFileSync("staging-ai-chat-certification.json", JSON.stringify(evidence, null, 2));
console.log("PASS: PawSpace V2 customer Chat AI completed two authenticated, grounded OpenAI turns on staging.");
console.log(JSON.stringify(evidence));
