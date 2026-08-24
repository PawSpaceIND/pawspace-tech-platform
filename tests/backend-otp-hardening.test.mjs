import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; },
  };
}

const SIGNING_KEY = "uat-signing-key-0123456789abcdef0123456789abcdef";
const ASSERTION_SECRET = "uat-assertion-secret-0123456789abcdef0123456789abcdef";

function freshPartnerDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = {
    DB: db,
    PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: ASSERTION_SECRET,
    PAWSPACE_UAT_LOGIN: "on",
    PAWSPACE_UAT_SIGNING_KEY: SIGNING_KEY,
  };
  return { sqlite, db };
}

test("customer and partner OTP request routes fail closed outside explicit UAT", async () => {
  globalThis.__PAWSPACE_TEST_ENV = {
    PAWSPACE_UAT_LOGIN: "off",
    PAWSPACE_UAT_SIGNING_KEY: SIGNING_KEY,
  };
  const customer = await import("../app/api/customer-otp/route.ts");
  const partner = await import("../app/api/partner-otp/route.ts");
  for (const [name, route] of [["customer", customer], ["partner", partner]]) {
    const response = await route.POST(new Request(`https://app.pawspace.in/api/${name}-otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "request", phone: "9876543210" }),
    }));
    assert.equal(response.status, 503, `${name} OTP request must refuse without the UAT gate`);
    const body = await response.json();
    assert.match(String(body.error), /not configured/i);
    assert.equal(Object.hasOwn(body, "sandboxCode"), false);
    assert.equal(JSON.stringify(body).includes("sandboxCode"), false);
  }
});

test("partner OTP double-consume race mints exactly one assertion", async () => {
  const { requestPartnerOtp, verifyPartnerOtp } = await import("../lib/partner-otp.ts");
  const { db } = freshPartnerDb();
  const challenge = await requestPartnerOtp(db, { phone: "9876543211" });
  const results = await Promise.allSettled([
    verifyPartnerOtp(db, { challengeId: challenge.challengeId, code: challenge.sandboxCode }),
    verifyPartnerOtp(db, { challengeId: challenge.challengeId, code: challenge.sandboxCode }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(rejected);
  assert.match(String(rejected.reason?.message), /already been used/);
});

test("separate valid partner OTP challenges for one phone converge on one canonical provider", async () => {
  const { requestPartnerOtp, verifyPartnerOtp } = await import("../lib/partner-otp.ts");
  const { sqlite, db } = freshPartnerDb();
  const first = await requestPartnerOtp(db, { phone: "9876543212" });
  const second = await requestPartnerOtp(db, { phone: "9876543212" });
  const results = await Promise.all([
    verifyPartnerOtp(db, { challengeId: first.challengeId, code: first.sandboxCode, name: "Provider One" }),
    verifyPartnerOtp(db, { challengeId: second.challengeId, code: second.sandboxCode, name: "Provider One" }),
  ]);
  assert.equal(results[0].providerId, results[1].providerId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM canonical_providers WHERE phone=?").get("9876543212").count, 1);
});

test("partner OTP wrong-attempt counter is capped at five", async () => {
  const { requestPartnerOtp, verifyPartnerOtp } = await import("../lib/partner-otp.ts");
  const { sqlite, db } = freshPartnerDb();
  const challenge = await requestPartnerOtp(db, { phone: "9876543213" });
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => verifyPartnerOtp(db, { challengeId: challenge.challengeId, code: "000000" }), /Incorrect OTP/);
  }
  await assert.rejects(() => verifyPartnerOtp(db, { challengeId: challenge.challengeId, code: challenge.sandboxCode }), /Too many incorrect attempts/);
  assert.equal(sqlite.prepare("SELECT attempts FROM partner_otp_challenges WHERE id=?").get(challenge.challengeId).attempts, 5);
});
