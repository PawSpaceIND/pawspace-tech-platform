import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

const PEPPER = "otp-pepper-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASSERTION_SECRET = "assertion-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TEST_SECRET = "sandbox-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

globalThis.__PAWSPACE_AUTH_HARDENING_DB__ = null;
globalThis.__pawspaceAuthTestEnv = {};
installWorkersHooks("__PAWSPACE_AUTH_HARDENING_DB__", "__pawspaceAuthTestEnv");

const customerOtp = await import("../lib/customer-otp.ts");
const partnerOtp = await import("../lib/partner-otp.ts");
const otpCrypto = await import("../lib/otp-crypto.ts");
const assertions = await import("../lib/verified-identity-assertion.ts");

function configureEnv(overrides = {}) {
  globalThis.__pawspaceAuthTestEnv = {
    PAWSPACE_OTP_PEPPER: PEPPER,
    PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: ASSERTION_SECRET,
    PAWSPACE_IDENTITY_ENV: "sandbox",
    PAWSPACE_IDENTITY_TEST_SECRET: TEST_SECRET,
    ...overrides,
  };
}

class MemoryDb {
  constructor() {
    this.customerChallenges = new Map();
    this.partnerChallenges = new Map();
    this.nonces = new Map();
    this.customer = { id: "CUS-OTP-TEST", name: "Test Customer", primary_phone: "9876543210", city_id: "blr" };
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ meta: { changes: 0 } }));
  }

  prepare(sql) {
    const statement = {
      args: [],
      bind: (...args) => { statement.args = args; return statement; },
      run: async () => {
        const args = statement.args;
        if (sql.startsWith("CREATE ")) return { meta: { changes: 0 } };
        if (sql.startsWith("INSERT INTO customer_otp_challenges")) {
          const [id, phone, code, createdAt, expiresAt] = args;
          this.customerChallenges.set(id, { id, phone, code, attempts: 0, consumed: 0, created_at: createdAt, expires_at: expiresAt });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO partner_otp_challenges")) {
          const [id, phone, code, createdAt, expiresAt] = args;
          this.partnerChallenges.set(id, { id, phone, code, attempts: 0, consumed: 0, created_at: createdAt, expires_at: expiresAt });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE customer_otp_challenges SET attempts=")) {
          const row = this.customerChallenges.get(args[0]);
          if (row && row.attempts < 5) row.attempts += 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (sql.startsWith("UPDATE partner_otp_challenges SET attempts=")) {
          const row = this.partnerChallenges.get(args[0]);
          if (row && row.attempts < 5 && !row.consumed) row.attempts += 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (sql.startsWith("UPDATE customer_otp_challenges SET consumed=1")) {
          const row = this.customerChallenges.get(args[0]);
          if (!row || row.consumed) return { meta: { changes: 0 } };
          row.consumed = 1;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO verified_identity_assertion_nonces")) {
          const [nonce, identitySource, principalKey, subjectType, subjectId, usedAt, expiresAt] = args;
          if (this.nonces.has(nonce)) return { meta: { changes: 0 } };
          this.nonces.set(nonce, { identitySource, principalKey, subjectType, subjectId, usedAt, expiresAt });
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unhandled test SQL run: ${sql}`);
      },
      first: async () => {
        const args = statement.args;
        if (sql.startsWith("SELECT * FROM customer_otp_challenges")) return this.customerChallenges.get(args[0]) ?? null;
        if (sql.startsWith("SELECT * FROM partner_otp_challenges")) return this.partnerChallenges.get(args[0]) ?? null;
        if (sql.includes("FROM canonical_customers WHERE primary_phone=?")) return this.customer?.primary_phone === args[0] ? this.customer : null;
        throw new Error(`Unhandled test SQL first: ${sql}`);
      },
    };
    return statement;
  }
}

function decodePayload(assertion) {
  const encoded = assertion.split(".")[0];
  const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - encoded.length % 4) % 4);
  return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
}

async function signLowLevel(payload) {
  const encoded = assertions.bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await assertions.hmac(encoded, ASSERTION_SECRET);
  return `${encoded}.${signature}`;
}

async function responseFailure(promise) {
  try {
    await promise;
    assert.fail("expected verification to reject");
  } catch (error) {
    assert.ok(error instanceof Response, `expected Response, got ${error}`);
    return error;
  }
}

test("ordinary customer and partner OTP requests never disclose raw codes", async () => {
  configureEnv();
  const db = new MemoryDb();
  const customer = await customerOtp.requestCustomerOtp(db, { phone: "9876543210", testSecret: TEST_SECRET });
  const partner = await partnerOtp.requestPartnerOtp(db, { phone: "9123456780", testSecret: TEST_SECRET });
  assert.equal(Object.hasOwn(customer, "sandboxCode"), false);
  assert.equal(Object.hasOwn(partner, "sandboxCode"), false);
  assert.match(db.customerChallenges.get(customer.challengeId).code, /^[a-f0-9]{64}$/);
  assert.match(db.partnerChallenges.get(partner.challengeId).code, /^[a-f0-9]{64}$/);
});

test("sandbox OTP disclosure requires sandbox mode and the dedicated credential", async () => {
  configureEnv({ PAWSPACE_IDENTITY_ENV: "production" });
  await assert.rejects(() => customerOtp.requestCustomerOtpForSandbox(new MemoryDb(), { phone: "9876543210", testSecret: TEST_SECRET }), /not authorized/);

  configureEnv();
  await assert.rejects(() => partnerOtp.requestPartnerOtpForSandbox(new MemoryDb(), { phone: "9123456780", testSecret: "wrong-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ" }), /not authorized/);

  const customerDb = new MemoryDb();
  const customer = await customerOtp.requestCustomerOtpForSandbox(customerDb, { phone: "9876543210", testSecret: TEST_SECRET });
  assert.match(customer.sandboxCode, /^\d{6}$/);
  assert.equal(
    customerDb.customerChallenges.get(customer.challengeId).code,
    await otpCrypto.hmacOtp(customer.challengeId, customer.sandboxCode, PEPPER),
  );

  const partnerDb = new MemoryDb();
  const partner = await partnerOtp.requestPartnerOtpForSandbox(partnerDb, { phone: "9123456780", testSecret: TEST_SECRET });
  assert.match(partner.sandboxCode, /^\d{6}$/);
  assert.equal(
    partnerDb.partnerChallenges.get(partner.challengeId).code,
    await otpCrypto.hmacOtp(partner.challengeId, partner.sandboxCode, PEPPER),
  );
});

test("customer OTP verification accepts the HMAC-backed challenge and rejects old plaintext rows", async () => {
  configureEnv();
  const db = new MemoryDb();
  const issued = await customerOtp.requestCustomerOtpForSandbox(db, { phone: "9876543210", testSecret: TEST_SECRET });
  const verified = await customerOtp.verifyCustomerOtp(db, { challengeId: issued.challengeId, code: issued.sandboxCode });
  assert.equal(verified.customerId, db.customer.id);
  assert.equal(db.customerChallenges.get(issued.challengeId).consumed, 1);

  const legacy = new MemoryDb();
  legacy.customerChallenges.set("OTP-LEGACY", {
    id: "OTP-LEGACY", phone: "9876543210", code: "123456", attempts: 0, consumed: 0,
    created_at: Date.now(), expires_at: Date.now() + 60_000,
  });
  await assert.rejects(() => customerOtp.verifyCustomerOtp(legacy, { challengeId: "OTP-LEGACY", code: "123456" }), /Incorrect OTP code/);
  assert.equal(legacy.customerChallenges.get("OTP-LEGACY").consumed, 0);
});

test("production partner signer can only produce partner_otp provider assertions", async () => {
  configureEnv();
  const assertion = await partnerOtp.signPartnerIdentityAssertion({ providerId: "PROV-1", phone: "9123456780", cityId: "blr" });
  const payload = decodePayload(assertion);
  assert.equal(payload.identitySource, "partner_otp");
  assert.equal(payload.subjectType, "provider");
  assert.equal(payload.subjectId, "PROV-1");
});

test("tampering with the encoded subjectId while retaining the signature fails signature validation", async () => {
  configureEnv();
  const now = Date.now();
  const original = await signLowLevel({
    v: 1, identitySource: "customer_otp", principalType: "identity_subject", principalKey: "9876543210",
    subjectType: "customer", subjectId: "CUS-1", cityId: "blr", issuedAt: now, expiresAt: now + 120_000, nonce: "NONCE-TAMPER",
  });
  const [encoded, signature] = original.split(".");
  const payload = decodePayload(original);
  payload.subjectId = "CUS-ATTACKER";
  const tamperedEncoded = assertions.bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  assert.notEqual(tamperedEncoded, encoded);
  const failure = await responseFailure(assertions.verifyIdentityAssertion(new MemoryDb(), `${tamperedEncoded}.${signature}`));
  assert.equal(failure.status, 401);
  assert.equal(await failure.text(), "Invalid identity assertion signature");
});

test("correctly signed partner_otp customer subject is rejected with the exact 401 mismatch", async () => {
  configureEnv();
  const now = Date.now();
  const invalid = await signLowLevel({
    v: 1, identitySource: "partner_otp", principalType: "identity_subject", principalKey: "9123456780",
    subjectType: "customer", subjectId: "CUS-1", cityId: "blr", issuedAt: now, expiresAt: now + 120_000, nonce: "NONCE-MISMATCH",
  });
  const failure = await responseFailure(assertions.verifyIdentityAssertion(new MemoryDb(), invalid));
  assert.equal(failure.status, 401);
  assert.equal(await failure.text(), "Partner OTP assertion subject mismatch");
});

test("invalid assertion lifetime is rejected before nonce consumption", async () => {
  configureEnv();
  const now = Date.now();
  const db = new MemoryDb();
  const invalid = await signLowLevel({
    v: 1, identitySource: "partner_otp", principalType: "identity_subject", principalKey: "9123456780",
    subjectType: "provider", subjectId: "PROV-1", cityId: "blr", issuedAt: now, expiresAt: now, nonce: "NONCE-LIFETIME",
  });
  const failure = await responseFailure(assertions.verifyIdentityAssertion(db, invalid));
  assert.equal(failure.status, 401);
  assert.equal(await failure.text(), "Invalid assertion lifetime");
  assert.equal(db.nonces.size, 0);
});
