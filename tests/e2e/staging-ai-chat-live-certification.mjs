import { writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";

const BASE = String(process.env.STAGING_URL || "https://pawspace-staging.karthik-fce.workers.dev").replace(/\/$/, "");
const ACCESS_CODE = String(process.env.PAWSPACE_UAT_ACCESS_CODE || "").trim();
const FOUNDER_EMAIL = "founder@pawspace.in";
// A fresh sandbox customer per run: chat reuses a customer's newest open thread, so a fixed phone would
// carry old UAT or human conversation into both turns and make the same-thread check meaningless.
const freshCustomer = (label) => ({ phone: `99999${String(randomInt(0, 100000)).padStart(5, "0")}`, name: `UAT Chat ${label}`, cityId: "blr" });
const REQUEST_TIMEOUT_MS = 30_000;
const EVIDENCE_FILE = "staging-ai-chat-certification.json";

// Evidence is built only from allowlisted tokens and numbers, never raw network text.
const token = (value) => (typeof value === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : null);
const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0);
const writeEvidence = (evidence) => writeFileSync(EVIDENCE_FILE, JSON.stringify({ ...evidence, secretValuesRecorded: false }, null, 2));

const fail = (message, detail = {}) => {
  console.error(`FAIL: ${message}`);
  if (Object.keys(detail).length) console.error(JSON.stringify(detail));
  writeEvidence({ ok: false, failedAt: new Date().toISOString(), stagingOrigin: BASE, failure: message });
  process.exit(1);
};

if (!ACCESS_CODE) fail("PAWSPACE_UAT_ACCESS_CODE is required for the founder configuration check.");

async function request(method, path, { cookie = "", body } = {}) {
  const headers = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  let response, raw;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    fail(timedOut ? `Staging did not answer ${method} ${path} within ${REQUEST_TIMEOUT_MS}ms` : `Staging request ${method} ${path} failed`, { error: String(error?.name || "error") });
  }
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

  // Certification verifies the rollout; it never changes it. Enabling customer AI on shared staging is a
  // governed decision made through /api/ai-rollout by an owner, not a side effect of a CI run.
  const data = status.body?.data || {};
  if (data.provider?.connected !== true) {
    fail("OpenAI provider is not connected", { reason: data.provider?.reason || "unknown" });
  }
  if (data.provider?.providerRef !== "openai") {
    fail("Staging is not using OpenAI", { providerRef: data.provider?.providerRef || "unknown" });
  }
  if (data.configurationRequired === true) fail("AI grounding is still incomplete");
  if (data.rollout?.customersEnabled !== true) {
    fail("Customer AI rollout is not enabled on staging. Enable it through the governed AI rollout control, then re-run certification.");
  }
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

async function customerSession(customer) {
  const requested = await request("POST", "/api/customer-otp", {
    body: { action: "request", phone: customer.phone },
  });
  const challengeId = String(requested.body?.data?.challengeId || "");
  const sandboxCode = String(requested.body?.data?.sandboxCode || "");
  if (requested.status >= 200 && requested.status < 300 && requested.body?.data?.liveSmsDelivered === true) {
    fail("Staging customer OTP is in live SMS mode, so no sandbox code is returned. Certification needs sandbox OTP delivery on staging.");
  }
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
      name: customer.name,
      cityId: customer.cityId,
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

async function diagnosticAsk(cookie,label,message){
  const started=Date.now();
  console.log(`DIAG_START ${label}`);
  const result=await request("POST","/api/ai-web-chat",{cookie,body:{mode:"authenticated",message,idempotencyKey:`staging-ai-diag-${label}-${crypto.randomUUID()}`}});
  const data=result.body?.data||{},turn=data.ai?.turn||{};
  console.log(JSON.stringify({label,elapsedMs:Date.now()-started,status:result.status,outcome:turn.outcome||null,handoffReason:turn.handoffReason||null,provider:turn.provider||null,providerConnected:data.ai?.providerConnected===true,hasOutput:Boolean(String(turn.output||"").trim())}));
  return result;
}

const founderCookie=await founderSession();
await ensureAiReady(founderCookie);
const bypassCustomer=freshCustomer("Bypass");
const bypassCookie=await customerSession(bypassCustomer);
await diagnosticAsk(bypassCookie,"policy_bypass","I need a refund for yesterday's service.");
const providerCustomer=freshCustomer("Provider");
const providerCookie=await customerSession(providerCustomer);
await diagnosticAsk(providerCookie,"provider_path","What PawSpace services can I book for my dog?");
writeEvidence({ok:true,diagnostic:true,completedAt:new Date().toISOString(),stagingOrigin:BASE});
console.log("PASS: staging AI chat timing diagnostic completed.");
