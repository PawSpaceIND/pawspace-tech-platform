import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "../helpers/module-hooks.mjs";
import { makeD1 } from "../helpers/voice-harness.mjs";
import { preflight } from "./sandbox-preflight.mjs";

// ---------------------------------------------------------------------------
// IDfy SANDBOX contract — real HTTP to the configured IDfy endpoint, real credentials.
//
// IDfy has no fixed sandbox hostname: the base is supplied entirely by IDFY_URL, so the sandbox is
// wherever that variable points. The preflight therefore probes the configured URL rather than a
// hardcoded host, and a run pointed at production would be visible in the log rather than silent.
//
// INT-KYC-01 records this integration as `environment:"none"` — no credential has ever been configured
// in any environment this code has run in. So the outbound leg here has never executed against IDfy,
// and the suite says so by skipping rather than by passing.
//
// The inbound leg goes through the production boundary (`applyIdfyCallback`), not a re-implementation
// of its HMAC. What it asserts is narrow and true: a correctly signed callback gets PAST signature
// verification, and a tampered one is refused 401. It deliberately does not assert the final status,
// because correlating to a real verification case needs a seeded case — which the executed local suites
// already cover.
// ---------------------------------------------------------------------------

installWorkersHooks("__SANDBOX_IDFY_DB__", "__SANDBOX_IDFY_ENV__");

const API_KEY = "IDFY_API_KEY", ACCOUNT_ID = "IDFY_ACCOUNT_ID", URL_NAME = "IDFY_URL";
const WEBHOOK_SECRET = "IDFY_WEBHOOK_SECRET";

const state = await preflight({
  suite: "IDfy sandbox",
  required: [
    { name: API_KEY, hint: "IDfy sandbox API key" },
    { name: ACCOUNT_ID, hint: "IDfy sandbox account id" },
    { name: URL_NAME, hint: "full sandbox task-submission URL — this is what decides which IDfy environment is used" },
  ],
  probe: {
    url: String(process.env[URL_NAME] || "https://idfy-url-not-configured.invalid"),
    authenticated: true,
    headers: { "api-key": String(process.env[API_KEY] || ""), "account-id": String(process.env[ACCOUNT_ID] || "") },
  },
  ownerAction: 'docs/KARTHIK_PENDING_CLOSEOUT.md Batch A — provider KYC (INT-KYC-01, currently environment:"none")',
});

const client = await import("../../lib/idfy-verification-client.ts");
const boundary = await import("../../lib/idfy-callback-boundary.ts");

const env = () => ({ ...process.env });
const ref = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

test("IDFY-01: the client agrees it is configured once the three variables are present", state.gate(), async () => {
  assert.equal(client.idfyConfigured(env()), true, "idfyConfigured must be true when api key, account id and URL are all set");
});

test("IDFY-02: a real sandbox task submission returns a contract mapStatus can read", state.gate(), async () => {
  const referenceId = ref("KYC");
  const result = await client.verifyWithIdfy(env(), {
    checkType: "pan_basic",
    referenceId,
    // Deliberately a documented test identifier, not a real person's PAN. A KYC sandbox is still a
    // system that logs what it is asked to verify.
    payload: { pan: "ABCDE1234F", name: "PawSpace Contract Test" },
  });

  assert.equal(result.connected, true, `IDfy refused the submission: ${result.connected === false ? result.reason : ""}`);
  assert.ok(["verified", "manual_review", "failed"].includes(result.status), `mapStatus produced an unexpected status: ${result.status}`);
  assert.ok(String(result.reference).length > 0, "a correlation reference is required, or no callback can ever be matched");
  // The shape mapStatus actually reads. If IDfy renamed either field, every automatable check would
  // silently collapse to manual_review — a fail-safe direction, but one nobody would notice.
  const raw = result.raw || {};
  const hasStatusField = "status" in raw || "verification_status" in raw || (raw.result && typeof raw.result === "object");
  assert.ok(hasStatusField, `IDfy response carried none of the fields mapStatus reads: ${JSON.stringify(raw).slice(0, 200)}`);
  console.log(`IDFY-02 reference=${result.reference} status=${result.status}`);
});

test("IDFY-03: the callback boundary refuses a tampered signature and admits a correctly signed one", { ...state.gate(), ...(process.env[WEBHOOK_SECRET] ? {} : { skip: `${WEBHOOK_SECRET} is not configured — the inbound leg cannot be exercised` }) }, async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  await boundary.ensureIdfyCallbackTables(db);
  const secret = String(process.env[WEBHOOK_SECRET] || "");

  const rawBody = JSON.stringify({ task_id: ref("KYC"), status: "completed", result: { verification_status: "verified" } });
  const timestamp = String(Date.now());
  const signature = await boundary.idfyHmacHex(secret, `${timestamp}.${rawBody}`);
  const headers = (sig) => new Headers({
    "content-type": "application/json",
    [boundary.IDFY_SIGNATURE_HEADER]: sig,
    [boundary.IDFY_TIMESTAMP_HEADER]: timestamp,
  });

  const tampered = await boundary.applyIdfyCallback(db, env(), { rawBody, headers: headers(signature.replace(/.$/, "0")) });
  assert.equal(tampered.accepted, false, "a tampered signature must never be accepted");
  assert.equal(tampered.status, 401, `expected 401 for a bad signature, got ${tampered.status}: ${tampered.reason ?? ""}`);

  const signed = await boundary.applyIdfyCallback(db, env(), { rawBody, headers: headers(signature) });
  // Narrow on purpose: what is proven is that real key material passes verification. Anything after
  // that is correlation, which needs a seeded case and is covered by the local executed suites.
  assert.notEqual(signed.status, 401, `a correctly signed callback must get past verification, got 401: ${signed.reason ?? ""}`);
  console.log(`IDFY-03 signed callback passed verification (status ${signed.status}), tampered refused 401`);
});

test("IDFY-04: a stale signature is refused even though it verifies", { ...state.gate(), ...(process.env[WEBHOOK_SECRET] ? {} : { skip: `${WEBHOOK_SECRET} is not configured — the inbound leg cannot be exercised` }) }, async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  await boundary.ensureIdfyCallbackTables(db);
  const secret = String(process.env[WEBHOOK_SECRET] || "");
  const rawBody = JSON.stringify({ task_id: ref("KYC"), status: "completed" });
  // Just outside the documented window, signed correctly. Replay protection, not signature failure.
  const timestamp = String(Date.now() - boundary.IDFY_SIGNATURE_FRESHNESS_MS - 60_000);
  const signature = await boundary.idfyHmacHex(secret, `${timestamp}.${rawBody}`);
  const result = await boundary.applyIdfyCallback(db, env(), {
    rawBody,
    headers: new Headers({ [boundary.IDFY_SIGNATURE_HEADER]: signature, [boundary.IDFY_TIMESTAMP_HEADER]: timestamp }),
  });
  assert.equal(result.accepted, false, "a signature older than the freshness window must be refused");
  console.log(`IDFY-04 stale-but-valid signature refused: ${result.reason ?? result.status}`);
});
