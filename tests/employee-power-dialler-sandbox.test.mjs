import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-hooks.mjs";
import { makeD1, freshSqlite, istAt } from "./helpers/voice-harness.mjs";

const dialler = await import("../lib/employee-power-dialler.ts");
const policy = await import("../lib/power-dialler-policy.ts");

const TEN_AM_IST = istAt(10);
const ACTOR = "agent@pawspace.in";
const EMPLOYEE_PHONE = "9900000001";
const FIRST_PHONE = "9800000001";
const SECOND_PHONE = "9800000002";

function sandboxEnv() {
  return {
    PAWSPACE_VOICE_ENV: "uat",
    PAWSPACE_VOICE_UAT_APPROVED: "true",
    PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED: "true",
    PAWSPACE_VOICE_UAT_ALLOWLIST: [EMPLOYEE_PHONE, FIRST_PHONE, SECOND_PHONE].join(","),
    PAWSPACE_VOICE_STATUS_CALLBACK_URL: "https://uat.pawspace.in/api/dialler/callback",
    PAWSPACE_POWER_DIALLER_STATUS_CALLBACK_URL: "https://uat.pawspace.in/api/dialler/callback",
    EXOTEL_API_KEY: "sandbox-key",
    EXOTEL_API_TOKEN: "sandbox-token",
    EXOTEL_SID: "sandbox-sid",
    EXOTEL_CALLER_ID: "08000000000",
    EXOTEL_VOICE_APP_ID: "sandbox-app",
    EXOTEL_WEBHOOK_SECRET: "sandbox-webhook-secret",
  };
}

async function seeded() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  await dialler.ensureEmployeePowerDiallerTables(db);
  sqlite.exec(`
    CREATE TABLE canonical_customers (
      id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,created_at INTEGER,updated_at INTEGER
    );
    CREATE TABLE customer_contact_preferences (
      customer_id TEXT PRIMARY KEY,marketing_consent INTEGER,service_consent INTEGER,opt_out INTEGER DEFAULT 0
    );
    CREATE TABLE lead_work_items (
      id TEXT PRIMARY KEY,customer_id TEXT,owner TEXT,service TEXT,status TEXT,last_outcome TEXT,
      call_attempts INTEGER DEFAULT 0,whatsapp_attempts INTEGER DEFAULT 0,first_action_at INTEGER,
      next_action_at INTEGER,opt_out INTEGER DEFAULT 0,assigned_at INTEGER,updated_at INTEGER
    );
  `);
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?)")
    .run("EMP-1", ACTOR, "EMP-1", "Sandbox Agent", ACTOR, EMPLOYEE_PHONE, TEN_AM_IST - 86_400_000, TEN_AM_IST, TEN_AM_IST);
  for (const [customerId, leadId, phone, score, queueId] of [
    ["C1", "L1", FIRST_PHONE, 95, "Q1"],
    ["C2", "L2", SECOND_PHONE, 90, "Q2"],
  ]) {
    sqlite.prepare("INSERT INTO canonical_customers (id,name,primary_phone,email,city_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(customerId, `Customer ${customerId}`, phone, `${customerId.toLowerCase()}@example.in`, "BLR", TEN_AM_IST, TEN_AM_IST);
    sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,opt_out) VALUES (?,1,1,0)").run(customerId);
    sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,owner,service,status,call_attempts,opt_out,assigned_at,updated_at) VALUES (?,?,?,'grooming','open',0,0,?,?)")
      .run(leadId, customerId, ACTOR, TEN_AM_IST, TEN_AM_IST);
    sqlite.prepare("INSERT INTO lead_scores (lead_id,engagement_score,profile_score,recency_score,value_score,total_score,grade,factors_json,computed_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(leadId, score, score, score, score, score, "A", "{}", TEN_AM_IST - 60_000);
    sqlite.prepare("INSERT INTO outbound_routing_queue (id,source_key,customer_id,lead_id,source_type,lane,priority_score,high_intent,lifecycle_code,status,context_json,created_at,updated_at) VALUES (?,?,?,?,?,'human',?,1,'grooming_renewal','queued','{}',?,?)")
      .run(queueId, `sandbox:${leadId}`, customerId, leadId, "grooming_renewal", score, TEN_AM_IST, TEN_AM_IST);
  }
  return { sqlite, db };
}

function basicCallbackHeaders(secret) {
  return new Headers({ authorization: `Basic ${Buffer.from(`sandbox:${secret}`).toString("base64")}` });
}

test("10:00 IST sandbox clock, mocked Exotel callback, CRM score refresh and 3s auto-advance are isolated from live carrier", async (t) => {
  t.mock.method(Date, "now", () => TEN_AM_IST);
  const { sqlite, db } = await seeded();
  const env = sandboxEnv();
  const requests = [];
  const fakeExotelFetch = async (url, init) => {
    const request = { url: String(url), body: String(init?.body || "") };
    requests.push(request);
    assert.match(request.url, /\/v1\/Accounts\/sandbox-sid\/Calls\/connect\.json$/);
    const form = new URLSearchParams(request.body);
    assert.equal(form.get("From"), `+91${EMPLOYEE_PHONE}`);
    assert.equal(form.get("StatusCallback"), env.PAWSPACE_POWER_DIALLER_STATUS_CALLBACK_URL);
    assert.ok([`+91${FIRST_PHONE}`, `+91${SECOND_PHONE}`].includes(form.get("To")));
    return new Response(JSON.stringify({ Call: { Sid: `EXO-SANDBOX-${requests.length}`, Status: "queued" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const first = await dialler.claimAndDialNextHuman(db, env, { actorId: ACTOR, fetcher: fakeExotelFetch });
  assert.equal(first.status, "dialing", "10:00 IST must pass the real 09:00-21:00 policy gate");
  assert.equal(first.call.queueId, "Q1");
  assert.equal(requests.length, 1, "only the injected fake carrier may be contacted");
  assert.equal(new URLSearchParams(requests[0].body).get("To"), `+91${FIRST_PHONE}`);

  const callbackBody = new URLSearchParams({
    CallSid: first.call.providerCallId,
    CallStatus: "completed",
    CustomField: first.call.id,
    CallDuration: "42",
    RecordingUrl: "https://sandbox.invalid/recordings/EXO-SANDBOX-1.mp3",
  }).toString();
  const callback = await dialler.applyEmployeePowerDiallerCallback(db, env, {
    rawBody: callbackBody,
    headers: basicCallbackHeaders(env.EXOTEL_WEBHOOK_SECRET),
    asOf: TEN_AM_IST + 60_000,
  });
  assert.equal(callback.verifiedBy, "basic");
  assert.equal(callback.call.status, "completed");
  assert.equal(Number(callback.call.duration_seconds), 42);
  assert.equal(callback.call.recording_url, "https://sandbox.invalid/recordings/EXO-SANDBOX-1.mp3");

  const beforeScore = sqlite.prepare("SELECT computed_at FROM lead_scores WHERE lead_id='L1'").get().computed_at;
  const disposition = await dialler.dispositionEmployeePowerCall(db, {
    actorId: ACTOR,
    queueId: "Q1",
    disposition: "interested",
    asOf: TEN_AM_IST + 120_000,
  });
  assert.equal(disposition.status, "completed");
  assert.equal(disposition.autoAdvanceAfterMs, 3000);
  assert.equal(disposition.leadScore.leadId, "L1");
  const refreshed = sqlite.prepare("SELECT total_score,computed_at FROM lead_scores WHERE lead_id='L1'").get();
  assert.notEqual(refreshed.computed_at, beforeScore, "disposition must recompute and persist the PR #515 lead score");
  assert.equal(refreshed.computed_at, TEN_AM_IST, "score refresh must use the mocked system clock");

  let scheduled = null;
  let secondPromise = null;
  policy.schedulePowerDiallerAdvance(
    () => { secondPromise = dialler.claimAndDialNextHuman(db, env, { actorId: ACTOR, fetcher: fakeExotelFetch }); },
    (callbackFn, delayMs) => { scheduled = { callbackFn, delayMs }; return { sandboxTimer: true }; },
  );
  assert.equal(scheduled.delayMs, 3000);
  assert.equal(requests.length, 1, "the next customer must not be dialled before the 3-second timer fires");
  scheduled.callbackFn();
  const second = await secondPromise;
  assert.equal(second.status, "dialing");
  assert.equal(second.call.queueId, "Q2", "the next Score 80+ CRM customer must advance after the disposition delay");
  assert.equal(requests.length, 2);
  assert.equal(new URLSearchParams(requests[1].body).get("To"), `+91${SECOND_PHONE}`);
});

test("real quiet-hour policy still fails closed outside the mocked daytime case", async () => {
  const { db } = await seeded();
  let contacted = false;
  const result = await dialler.claimAndDialNextHuman(db, sandboxEnv(), {
    actorId: ACTOR,
    asOf: istAt(21),
    fetcher: async () => { contacted = true; throw new Error("carrier must not be contacted"); },
  });
  assert.equal(result.status, "quiet_hours");
  assert.equal(contacted, false);
});
