import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, seedRecipient, uatVoiceEnv, ALLOWLISTED_PHONE, DAYTIME } from "./helpers/voice-harness.mjs";

// ---------------------------------------------------------------------------
// The voice API surface, executed - handlers driven on a REAL host, plus the worker gateway's own
// permission mapping.
//
// Two things this found on main, both real:
//
//   1. /api/ai-voice-uat had no permission check at all. It called resolveActor() and went to work, so
//      the only gate was the worker gateway - and the gateway had no mapping for the path, which means it
//      fell through to the fail-closed default of dashboard.view. `auditor` (read-only compliance) and
//      `finance` both hold dashboard.view and neither holds communications.call, so either could start an
//      AI voice call, record transcript segments and transfer a call to a live agent.
//
//   2. recordAiVoiceTransportFailure() and completeAiVoiceCall() took no actor at all. The route passed
//      only a callId, so any identity the gateway admitted could fail or complete ANY call by id -
//      including another customer's call, and including turning a live-agent transfer into a
//      "completed" row.
//
// Every case builds its request on https://ops.pawspace.example. A preview host (localhost /
// 127.0.0.1 / terminal.local) is granted a superuser actor holding ["*"], which would make every
// assertion here vacuous.
// ---------------------------------------------------------------------------

installWorkersHooks("__VRA_DB__", "__VRA_ENV__");
const HOST = "https://ops.pawspace.example";
const serverAuth = await import("../lib/server-auth.ts");
const gateway = await import("../lib/api-gateway.ts");
const gov = await import("../lib/voice-outbound-governance.ts");

const ROLES = {
  founder: ["*"],
  admin: ["dashboard.view", "customers.view", "customers.manage", "bookings.view", "bookings.manage", "communications.call", "communications.message", "settings.manage"],
  associate: ["dashboard.view", "customers.view", "bookings.view", "communications.call", "communications.message", "self_service.view"],
  service_provider: ["bookings.view", "scheduling.view", "communications.call", "communications.message", "self_service.view"],
  auditor: ["dashboard.view", "reports.view", "audit.view"],
  finance: ["dashboard.view", "payments.view", "finance.view", "finance.manage", "reports.view", "audit.view"],
  customer: ["pricing.view", "scheduling.book"],
};

async function fresh(envOverrides = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__VRA_DB__ = db;
  globalThis.__VRA_ENV__ = { ...uatVoiceEnv(), ...envOverrides };
  await serverAuth.ensureSecurityTables(db);
  const now = Date.now();
  for (const [role, permissions] of Object.entries(ROLES)) {
    sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,1,?)").run(role, role, role, JSON.stringify(permissions), now);
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`USR-${role}`, `${role}@pawspace.in`, role, role, now, now);
  }
  await gov.ensureVoiceCallTables(db);
  await gov.seedVoiceCallScripts(db);
  seedRecipient(sqlite);
  return { sqlite, db, env: globalThis.__VRA_ENV__ };
}

async function call(path, method, body, role) {
  const route = await import(`../app/api/${path}/route.ts`);
  const headers = { "content-type": "application/json", ...(role ? { "oai-authenticated-user-email": `${role}@pawspace.in` } : {}) };
  const init = method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) };
  const response = await route[method](new Request(`${HOST}/api/${path}`, init));
  let parsed = null;
  try { parsed = await response.json(); } catch { /* non-JSON body */ }
  return { status: response.status, body: parsed };
}

test("the gateway maps every voice path explicitly, not through the dashboard.view fallback", async () => {
  const probe = async (path, method = "POST") => {
    const sqlite = freshSqlite();
    const env = { DB: makeD1(sqlite) };
    await serverAuth.ensureSecurityTables(env.DB);
    const now = Date.now();
    sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES ('auditor','a','a',?,1,?)").run(JSON.stringify(ROLES.auditor), now);
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U','auditor@pawspace.in','a','auditor','active',?,?)").run(now, now);
    const init = method === "GET" ? { headers: { "oai-authenticated-user-email": "auditor@pawspace.in" } } : { method, headers: { "content-type": "application/json", "oai-authenticated-user-email": "auditor@pawspace.in" }, body: "{}" };
    return gateway.authorizeApiRequest(new Request(`${HOST}${path}`, init), env);
  };
  // An auditor holds dashboard.view. Under the old fallback each of these was ADMITTED by the gateway.
  for (const path of ["/api/ai-voice-uat", "/api/voice-speech", "/api/voice-outbound", "/api/voice-providers"]) {
    const access = await probe(path);
    assert.ok(access instanceof Response, `${path} must not admit an auditor`);
    assert.equal(access.status, 403, path);
  }
  // The provider callback is allowlisted because a carrier has no session. Its handler treats CallSid as
  // trigger-only, proves D1 ownership, then fetches authoritative status from Exotel before mutation.
  const webhook = await probe("/api/voice-provider-webhook");
  assert.ok(!(webhook instanceof Response));
  assert.equal(webhook.permission, null, "the callback path is public at the gateway and reconciliation-gated in the handler");
});

test("the gateway admits only an identity that holds the mapped permission", async () => {
  const probe = async (path, role) => {
    const sqlite = freshSqlite();
    const env = { DB: makeD1(sqlite) };
    await serverAuth.ensureSecurityTables(env.DB);
    const now = Date.now();
    sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,1,?)").run(role, role, role, JSON.stringify(ROLES[role]), now);
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`U-${role}`, `${role}@pawspace.in`, role, role, now, now);
    const access = await gateway.authorizeApiRequest(new Request(`${HOST}${path}`, { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": `${role}@pawspace.in` }, body: "{}" }), env);
    return access instanceof Response ? access.status : 200;
  };
  assert.equal(await probe("/api/voice-outbound", "admin"), 200);
  assert.equal(await probe("/api/voice-outbound", "associate"), 403, "an associate may phone a customer, not launch a dialler");
  assert.equal(await probe("/api/voice-outbound", "service_provider"), 403);
  assert.equal(await probe("/api/voice-outbound", "customer"), 403);
  assert.equal(await probe("/api/ai-voice-uat", "associate"), 200, "conversing needs communications.call, which an associate holds");
  assert.equal(await probe("/api/ai-voice-uat", "finance"), 403);
});

test("an anonymous caller gets nothing from any voice route", async () => {
  await fresh();
  for (const [path, method] of [["voice-outbound", "GET"], ["voice-outbound", "POST"], ["ai-voice-uat", "POST"], ["voice-providers", "GET"], ["voice-speech", "GET"], ["voice-speech", "POST"]]) {
    const result = await call(path, method, {}, null);
    assert.ok([401, 403].includes(result.status), `${method} /api/${path} answered ${result.status} to an anonymous caller`);
  }
});

test("a read-only compliance identity cannot start, drive or end an AI voice call", async () => {
  await fresh();
  for (const role of ["auditor", "finance"]) {
    for (const body of [
      { action: "start", customerId: "CON-V1", direction: "outbound", transportProvider: "sandbox_simulator", consent: true },
      { action: "segment", callId: "AIVCALL-X", segmentIndex: 1, speaker: "customer", text: "hello" },
      { action: "transfer", callId: "AIVCALL-X" },
      { action: "transport_failure", callId: "AIVCALL-X" },
      { action: "complete", callId: "AIVCALL-X" },
    ]) {
      const result = await call("ai-voice-uat", "POST", body, role);
      assert.equal(result.status, 403, `${role} ${body.action} answered ${result.status}`);
    }
  }
});

test("completing or failing a call now requires authority over that call, not just a call id", async () => {
  const { sqlite, db } = await fresh();
  const now = Date.now();
  const staff = { email: "admin@pawspace.in", roleCode: "admin", permissions: ROLES.admin, developmentPreview: false, identitySource: "workspace", principalType: "email", principalKey: "admin@pawspace.in" };
  const voice = await import("../lib/ai-voice-uat.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY, consent_json TEXT)");
  const started = await voice.startAiVoiceUatCall(db, { actor: staff, customerId: "CON-V1", direction: "outbound", transportProvider: "sandbox_simulator", consent: true });

  // An identity with dashboard.view but no communications.call is exactly what the gateway used to admit.
  const auditor = { email: "auditor@pawspace.in", roleCode: "auditor", permissions: ROLES.auditor, developmentPreview: false, identitySource: "workspace", principalType: "email", principalKey: "auditor@pawspace.in" };
  await assert.rejects(() => voice.completeAiVoiceCall(db, { actor: auditor, callId: started.callId, outcome: "resolved", disposition: "done" }), (error) => error instanceof Response && error.status === 403);
  await assert.rejects(() => voice.recordAiVoiceTransportFailure(db, { actor: auditor, callId: started.callId, reason: "x", reconnected: false }), (error) => error instanceof Response && error.status === 403);
  assert.equal(sqlite.prepare("SELECT status FROM ai_voice_calls WHERE id=?").get(started.callId).status, "active", "the call was untouched");

  // A customer identity bound to a DIFFERENT customer cannot end this call either.
  const stranger = { email: "other@customer.test", roleCode: "customer", permissions: [...ROLES.customer, "communications.call"], developmentPreview: false, identitySource: "customer_otp", principalType: "identity_subject", principalKey: "customer:CON-OTHER" };
  // ensureSecurityTables already owns customer_identity_links, including its NOT NULL columns.
  sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)")
    .run("other@customer.test", "CON-OTHER", now, now);
  await assert.rejects(() => voice.completeAiVoiceCall(db, { actor: stranger, callId: started.callId, outcome: "resolved", disposition: "done" }), (error) => error instanceof Response && error.status === 403);
  assert.equal(sqlite.prepare("SELECT status FROM ai_voice_calls WHERE id=?").get(started.callId).status, "active");

  // Staff with authority over the customer still complete it, so this is a boundary and not a lockout.
  const done = await voice.completeAiVoiceCall(db, { actor: staff, callId: started.callId, outcome: "resolved", disposition: "ai_completed" });
  assert.equal(done.completed, true);
  await assert.rejects(() => voice.completeAiVoiceCall(db, { actor: staff, callId: "AIVCALL-NOPE", outcome: "x", disposition: "y" }), /Voice call not found/);
});

test("a service provider cannot point the dialler at a customer, an admin can", async () => {
  await fresh();
  const request = { action: "request_call", idempotencyKey: "route-1", useCase: "booking_confirmation", phone: ALLOWLISTED_PHONE, cityId: "blr", customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1" };
  for (const role of ["service_provider", "associate", "auditor", "finance", "customer"]) {
    const result = await call("voice-outbound", "POST", request, role);
    assert.equal(result.status, 403, `${role} answered ${result.status}`);
  }
  const admin = await call("voice-outbound", "POST", request, "admin");
  // 409, not 201: an authorised caller still has to satisfy the policy gate, and the HTTP status has to
  // say the call did not happen rather than reporting a refusal as created.
  assert.equal(admin.status, 409);
  assert.equal(admin.body.data.state, "blocked_consent");
  assert.equal(admin.body.data.dialled, false);
});

test("no request field can enable voice through the route", async () => {
  await fresh({ PAWSPACE_VOICE_ENV: "", PAWSPACE_VOICE_UAT_APPROVED: "" });
  const result = await call("voice-outbound", "POST", {
    action: "request_call", idempotencyKey: "route-off", useCase: "booking_confirmation",
    phone: ALLOWLISTED_PHONE, cityId: "blr", customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1",
    voiceEnabled: true, PAWSPACE_VOICE_ENV: "uat", PAWSPACE_VOICE_UAT_APPROVED: "true", force: true, mode: "live",
  }, "founder");
  assert.equal(result.status, 503, "a disabled environment answers 503, not 201");
  assert.equal(result.body.data.state, "blocked_disabled");
  assert.equal(result.body.data.dialled, false);
});

test("changing a call script needs settings.manage on top of the call permissions", async () => {
  await fresh();
  const compliant = 'Hello, this is PawSpace’s automated assistant about your booking. Say "agent" for a team member, or "do not call" to stop calling.';
  const body = { action: "set_script", useCase: "booking_confirmation", openingDisclosure: compliant };
  // The seeded admin above holds settings.manage; a manager-shaped identity without it must not.
  const { sqlite } = await fresh();
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES ('manager','m','m',?,1,?)").run(JSON.stringify(["dashboard.view", "customers.manage", "communications.call"]), now);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-M','manager@pawspace.in','m','manager','active',?,?)").run(now, now);
  assert.equal((await call("voice-outbound", "POST", body, "manager")).status, 403);
  assert.equal((await call("voice-outbound", "POST", body, "admin")).status, 201);
});

test("a cross-origin voice write is refused before anything is read", async () => {
  await fresh();
  for (const path of ["voice-outbound", "ai-voice-uat"]) {
    const route = await import(`../app/api/${path}/route.ts`);
    const response = await route.POST(new Request(`${HOST}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", "oai-authenticated-user-email": "founder@pawspace.in" },
      body: JSON.stringify({ action: "request_call" }),
    }));
    assert.equal(response.status, 403, path);
  }
});

test("the readiness surface is legible to an authorised operator and names no secret value", async () => {
  await fresh();
  const result = await call("voice-outbound", "GET", null, "admin");
  assert.equal(result.status, 200);
  assert.equal(result.body.data.productionCallsPlaced, 0);
  assert.equal(result.body.data.gate.enabled, true);
  assert.equal(result.body.data.transport.productionCapable, false);
  const serialised = JSON.stringify(result.body);
  for (const secret of ["test-key", "test-token", "test-sid", "test-webhook-secret"]) assert.ok(!serialised.includes(secret), secret);
});

test("the provider callback route treats an unknown CallSid as inert and refuses an oversized payload", async () => {
  await fresh();
  const route = await import("../app/api/voice-provider-webhook/route.ts");
  const unknown = await route.POST(new Request(`${HOST}/api/voice-provider-webhook`, { method: "POST", body: "CallSid=EX-1&CustomField=VCALL-1&CallStatus=completed" }));
  assert.equal(unknown.status, 202, "an unowned CallSid is acknowledged inertly and must not trigger provider lookup or mutation");
  const oversized = await route.POST(new Request(`${HOST}/api/voice-provider-webhook`, { method: "POST", body: "x".repeat(70_000) }));
  assert.equal(oversized.status, 413, "an oversized provider body is refused before it is parsed");
});

test("a call audit is only readable by an identity authorised for voice", async () => {
  const { db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const placed = await gov.requestOutboundVoiceCall(db, env, { idempotencyKey: "audit-1", useCase: "booking_confirmation", phone: ALLOWLISTED_PHONE, cityId: "blr", customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1", actorId: "admin@pawspace.in", actorPermissions: ROLES.admin, asOf: DAYTIME });
  assert.equal(placed.dialled, true);
  const route = await import("../app/api/voice-outbound/route.ts");
  const denied = await route.GET(new Request(`${HOST}/api/voice-outbound?scope=audit&callId=${placed.callId}`, { headers: { "oai-authenticated-user-email": "auditor@pawspace.in" } }));
  assert.equal(denied.status, 403);
  const allowed = await route.GET(new Request(`${HOST}/api/voice-outbound?scope=audit&callId=${placed.callId}`, { headers: { "oai-authenticated-user-email": "admin@pawspace.in" } }));
  assert.equal(allowed.status, 200);
  const audit = (await allowed.json()).data;
  assert.equal(audit.call.callId, placed.callId);
  assert.equal(audit.policyDecisions.length, 10);
});

test("only a real boolean true counts as voice consent", async () => {
  const { sqlite } = await fresh();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY, consent_json TEXT)");
  // Boolean("false") is true, so a client sending consent:"false" used to satisfy the gate and produce a
  // row stamped consent_status='verified'.
  for (const consent of ["false", "no", "0", 0, 1, "true", "yes", [], {}, null, undefined]) {
    const result = await call("ai-voice-uat", "POST", { action: "start", customerId: "CON-V1", direction: "outbound", transportProvider: "sandbox_simulator", consent }, "admin");
    assert.equal(result.status, 403, `consent=${JSON.stringify(consent)} answered ${result.status}`);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM ai_voice_calls").get().c, 0, "no call row was created by any of them");
  const real = await call("ai-voice-uat", "POST", { action: "start", customerId: "CON-V1", direction: "outbound", transportProvider: "sandbox_simulator", consent: true }, "admin");
  assert.equal(real.status, 201);
});

test("a stalled provider body is bounded by the same deadline as a silent provider", async () => {
  // The timer used to be cleared around the fetch alone, leaving response.text() unbounded - so a
  // provider that sent headers and then stalled the stream held the request open indefinitely.
  const adapter = await import("../lib/voice-provider-adapter.ts");
  const speech = await import("../lib/voice-speech-failures.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Response(
    new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"text":')); init.signal.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }))); } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  try {
    const stt = adapter.resolveVoiceStt({ VOICE_STT_API_KEY: "k", VOICE_STT_URL: "https://stt.pawspace.in/x", VOICE_SPEECH_TIMEOUT_MS: "1000" });
    const started = Date.now();
    await assert.rejects(
      () => stt.transcribe({ audioRef: "data:audio/mpeg;base64,AAECAw==" }),
      (error) => error instanceof speech.VoiceSpeechError && error.code === "timeout",
    );
    assert.ok(Date.now() - started < 5000, "the stalled body hit the deadline instead of hanging");
  } finally { globalThis.fetch = original; }
});

test("an oversized request body is refused before it is buffered", async () => {
  await fresh();
  const webhook = await import("../app/api/voice-provider-webhook/route.ts");
  const outbound = await import("../app/api/voice-outbound/route.ts");

  // Declared oversized: refused on the content-length claim.
  const declared = await webhook.POST(new Request(`${HOST}/api/voice-provider-webhook`, { method: "POST", body: "x".repeat(70_000) }));
  assert.equal(declared.status, 413);

  // Chunked with NO content-length, and larger than the cap. request.text() would have buffered the
  // whole thing before any check could run.
  const chunked = () => new ReadableStream({
    start(controller) {
      for (let index = 0; index < 40; index++) controller.enqueue(new TextEncoder().encode("y".repeat(4096)));
      controller.close();
    },
  });
  const streamed = await webhook.POST(new Request(`${HOST}/api/voice-provider-webhook`, { method: "POST", body: chunked(), duplex: "half" }));
  assert.equal(streamed.status, 413, "a chunked oversized body is refused too");

  // Multibyte: String.length counts UTF-16 units, so 40k multibyte characters measure under a 65,536
  // "length" check while being well over 65,536 BYTES.
  const multibyte = "\u{1F415}".repeat(20_000);
  assert.ok(multibyte.length < 65_536, "the old length check would have passed this");
  assert.ok(new TextEncoder().encode(multibyte).byteLength > 65_536, "but it is over the byte limit");
  const wide = await webhook.POST(new Request(`${HOST}/api/voice-provider-webhook`, { method: "POST", body: multibyte }));
  assert.equal(wide.status, 413);

  // The staff route carries the same bound.
  const staff = await outbound.POST(new Request(`${HOST}/api/voice-outbound`, {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": "admin@pawspace.in" },
    body: JSON.stringify({ action: "request_call", pad: "z".repeat(70_000) }),
  }));
  assert.equal(staff.status, 413, "a staff credential is not a licence to send any size");

  // And a normal-sized body still works.
  const ok = await outbound.POST(new Request(`${HOST}/api/voice-outbound`, {
    method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": "admin@pawspace.in" },
    body: JSON.stringify({ action: "policy_preview", useCase: "booking_confirmation", phone: ALLOWLISTED_PHONE, cityId: "blr", customerId: "CON-V1" }),
  }));
  assert.equal(ok.status, 200);
});

test("inline audio is bounded before it is decoded, not after", async () => {
  const safe = await import("../lib/voice-safe-fetch.ts");
  // atob() on an unbounded payload allocates the whole decoded string before any size check could run,
  // so the bound has to be applied to the ENCODED length first.
  const huge = `data:audio/mpeg;base64,${"A".repeat(400_000)}`;
  const error = await (async () => { try { safe.decodeInlineAudio(huge, { maxBytes: 1024 }); return null; } catch (thrown) { return thrown; } })();
  assert.equal(error?.code, "too_large");
  // A payload inside the bound still decodes, so this is a limit and not a refusal of inline audio.
  assert.equal(safe.decodeInlineAudio("data:audio/mpeg;base64,AAECAw==", { maxBytes: 1024 }).bytes.byteLength, 4);
  // The post-decode check is retained for padding/decoder correctness: encoded length is an upper bound.
  const nearEdge = `data:audio/mpeg;base64,${"A".repeat(8)}`;
  assert.equal(safe.decodeInlineAudio(nearEdge, { maxBytes: 6 }).bytes.byteLength, 6);
  const overEdge = await (async () => { try { safe.decodeInlineAudio(`data:audio/mpeg;base64,${"A".repeat(12)}`, { maxBytes: 6 }); return null; } catch (thrown) { return thrown; } })();
  assert.equal(overEdge?.code, "too_large");
});

test("the stuck-call counter measures inactivity, not call age, and honours an injected clock", async () => {
  const { db, env } = await fresh();
  await gov.recordVoiceConsent(db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const call = await gov.requestOutboundVoiceCall(db, env, { idempotencyKey: "stuck-1", useCase: "booking_confirmation", phone: ALLOWLISTED_PHONE, cityId: "blr", customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1", actorId: "admin@pawspace.in", actorPermissions: ROLES.founder, asOf: DAYTIME });
  assert.equal(call.dialled, true);
  // Two hours after the request, but the call transitioned one minute ago: healthy, not stuck.
  await gov.transitionVoiceCall(db, { callId: call.callId, to: "connected", reason: "answered", actor: "test", asOf: DAYTIME + 2 * 3600_000 });
  assert.equal((await gov.voiceOutboundReadiness(db, env, DAYTIME + 2 * 3600_000 + 60_000)).callsOpenOverAnHour, 0, "a long, progressing call is not stuck");
  // Two hours after its last transition: stuck.
  assert.equal((await gov.voiceOutboundReadiness(db, env, DAYTIME + 4 * 3600_000)).callsOpenOverAnHour, 1);
});

test("a null or scalar JSON body is a 400, not a 500", async () => {
  await fresh();
  const route = await import("../app/api/voice-outbound/route.ts");
  // JSON.parse("null") returns null, so reading body.action off it threw a TypeError and the route
  // answered 500 to what is really a malformed request.
  for (const body of ["null", "1", "true", '"request_call"', "[]", "[1,2]", "not json at all", ""]) {
    const response = await route.POST(new Request(`${HOST}/api/voice-outbound`, {
      method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": "admin@pawspace.in" }, body,
    }));
    assert.ok(response.status < 500, `body ${JSON.stringify(body)} answered ${response.status}`);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test("a nonsense byte limit makes the audio guard refuse, not proceed", async () => {
  const safe = await import("../lib/voice-safe-fetch.ts");
  const big = `data:audio/mpeg;base64,${"A".repeat(4096)}`;
  // Infinity/3 rounds to an infinite ceiling and any comparison against NaN is false, so both size
  // bounds would have failed OPEN and handed an unbounded payload to atob().
  for (const maxBytes of [Infinity, NaN, -1, Number.POSITIVE_INFINITY]) {
    const error = await (async () => { try { safe.decodeInlineAudio(big, { maxBytes }); return null; } catch (thrown) { return thrown; } })();
    assert.equal(error?.code, "invalid_limit", `maxBytes=${maxBytes}`);
  }
  // A sane limit still works, so this is a guard and not a lockout.
  assert.equal(safe.decodeInlineAudio("data:audio/mpeg;base64,AAECAw==", { maxBytes: 1024 }).bytes.byteLength, 4);
});

test("a call stranded in ANY non-terminal state is surfaced as open", async () => {
  const machine = await import("../lib/voice-call-state.ts");
  const ctx = await fresh();
  await gov.recordVoiceConsent(ctx.db, { phone: ALLOWLISTED_PHONE, subjectType: "customer", subjectId: "CON-V1", granted: true, source: "booking_form_consent", actorId: "ops@pawspace.in", asOf: DAYTIME });
  const call = await gov.requestOutboundVoiceCall(ctx.db, ctx.env, { idempotencyKey: "open-1", useCase: "booking_confirmation", phone: ALLOWLISTED_PHONE, cityId: "blr", customerId: "CON-V1", leadId: "LEAD-V1", bookingId: "BKG-V1", actorId: "admin@pawspace.in", actorPermissions: ROLES.founder, asOf: DAYTIME });

  // `queued` was missing from the enumerated list: a call whose execution stopped between the queued
  // transition and provider contact holds an ACTIVE dial reservation, consuming the recipient's cap,
  // while being invisible on the readiness surface.
  for (const state of ["requested", "policy_check", "queued", "dialing", "connected", "handoff_requested", "no_answer"]) {
    ctx.sqlite.prepare("UPDATE voice_call_orders SET state=?,updated_at=? WHERE id=?").run(state, DAYTIME, call.callId);
    const readiness = await gov.voiceOutboundReadiness(ctx.db, ctx.env, DAYTIME + 2 * 3600_000);
    assert.equal(readiness.callsOpenOverAnHour, 1, `${state} must count as open`);
  }
  // Terminal states never count, and the set is derived from the machine rather than enumerated here.
  for (const state of machine.VOICE_TERMINAL_STATES) {
    ctx.sqlite.prepare("UPDATE voice_call_orders SET state=?,updated_at=? WHERE id=?").run(state, DAYTIME, call.callId);
    assert.equal((await gov.voiceOutboundReadiness(ctx.db, ctx.env, DAYTIME + 2 * 3600_000)).callsOpenOverAnHour, 0, `${state} is terminal`);
  }
});

test("recording is refused at the provider boundary without the environment approval", async () => {
  const telephony = await import("../lib/voice-telephony-provider.ts");
  const { uatVoiceEnv } = await import("./helpers/voice-harness.mjs");
  const env = uatVoiceEnv({ PAWSPACE_VOICE_TRANSPORT: "" });
  const intent = { callRef: "VCALL-X", toNumber: "+919876543210", statusCallbackUrl: env.PAWSPACE_VOICE_STATUS_CALLBACK_URL, recordingAllowed: true };
  // Recording is a consent decision. Sending Record=true on the caller's word alone would let a direct
  // provider caller start carrier-side recording with the approval flag unset.
  await assert.rejects(
    () => telephony.exotelTelephony(env).createCall(intent),
    /Call recording is not approved/,
  );
  // With the approval present the same intent gets as far as the network call (which then fails, since
  // there is no Exotel to answer) - proving the refusal above came from the approval check.
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ Call: { Sid: "EX-1", Status: "queued" } });
  try {
    const approvedEnv = uatVoiceEnv({ PAWSPACE_VOICE_TRANSPORT: "", PAWSPACE_VOICE_RECORDING_APPROVED: "true" });
    const handle = await telephony.exotelTelephony(approvedEnv).createCall({ ...intent, statusCallbackUrl: approvedEnv.PAWSPACE_VOICE_STATUS_CALLBACK_URL });
    assert.equal(handle.providerCallId, "EX-1");
  } finally { globalThis.fetch = original; }
  // And a non-recording call is unaffected either way.
  globalThis.fetch = async () => Response.json({ Call: { Sid: "EX-2", Status: "queued" } });
  try {
    const handle = await telephony.exotelTelephony(env).createCall({ ...intent, recordingAllowed: false });
    assert.equal(handle.providerCallId, "EX-2");
  } finally { globalThis.fetch = original; }
});