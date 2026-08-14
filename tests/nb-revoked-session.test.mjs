/**
 * P1-2 RUNTIME CLOSURE — revoked / deactivated customer session.
 *
 * A verified customer platform session authenticates protected reads and writes. The moment that session
 * is revoked (explicit sign-out / security action) OR the underlying identity binding is deactivated, the
 * SAME cookie must stop working: resolveActor (lib/server-auth.ts) resolves no principal and throws 401
 * BEFORE any handler logic runs — so no protected data is returned and no write lands.
 *
 * Driven through the REAL route handler (pawspace-wallet) with a REAL platform session cookie minted via
 * issuePlatformSession, on a NON-LOCALHOST host so the development-preview superuser shortcut (which
 * bypasses every check on localhost) cannot mask the boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__REVSESS_DB__", "__REVSESS_ENV__");

const HOST = "https://app.pawspace.in"; // non-localhost: no development-preview superuser
const CUSTOMER = "CUS-REV", PHONE = "+919000004444";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__REVSESS_DB__ = db;
  globalThis.__REVSESS_ENV__ = {}; // PAWSPACE_UAT_LOGIN unset: the staging sign-in path stays inert
  return { sqlite, db };
}

/** Mint a real verified customer session — the exact path the customer app uses. */
async function mintSession(db) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: PHONE,
    subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified",
    actorId: "test", reason: "revoked-session test",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: CUSTOMER,
  });
  return { cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`, bindingId: String(binding.id) };
}

const wallet = () => import("../app/api/pawspace-wallet/route.ts");
const getWallet = (cookie) => new Request(`${HOST}/api/pawspace-wallet?customerId=${CUSTOMER}`, { headers: cookie ? { cookie } : {} });
const postRedeem = (cookie) => new Request(`${HOST}/api/pawspace-wallet`, {
  method: "POST",
  headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
  body: JSON.stringify({ customerId: CUSTOMER, walletAmount: 100, bookingId: "BK-REV", idempotencyKey: "rev-redeem-1" }),
});

test("CONTROL: a live verified session reads its OWN protected wallet (authenticated, owns the data)", async () => {
  const { db } = freshDb();
  const { cookie } = await mintSession(db);
  const res = await (await wallet()).GET(getWallet(cookie));
  assert.notEqual(res.status, 401, "a live session must authenticate");
  assert.notEqual(res.status, 403, "the rightful owner must not be refused");
  const body = await res.json();
  assert.ok(body.data && typeof body.data.balance === "number", `protected wallet data is returned to the owner: ${JSON.stringify(body)}`);
});

test("explicit session revoke -> the same cookie is refused 401 on a protected READ, with no protected data", async () => {
  const { db } = freshDb();
  const { cookie } = await mintSession(db);
  const { revokePlatformSession } = await import("../lib/platform-session.ts");
  // A sign-out / security action revokes the session server-side.
  const revoked = await revokePlatformSession(db, getWallet(cookie));
  assert.ok(revoked, "the live session was found and revoked");

  const res = await (await wallet()).GET(getWallet(cookie));
  assert.equal(res.status, 401, `a revoked session must be refused on read: ${res.status}`);
  const body = await res.json();
  assert.equal(body.data, undefined, "no protected data leaks on the 401");
});

test("explicit session revoke -> a protected WRITE with the same cookie is refused 401 and writes nothing", async () => {
  const { sqlite, db } = freshDb();
  const { cookie } = await mintSession(db);
  // Baseline read (live session) — this also materialises the wallet ledger table so the no-write
  // assertion below queries a real, empty table rather than a missing one.
  const baseline = await (await wallet()).GET(getWallet(cookie));
  assert.notEqual(baseline.status, 401);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM pawspace_wallet_ledger WHERE customer_id=?").get(CUSTOMER).c, 0, "baseline ledger is empty");

  const { revokePlatformSession } = await import("../lib/platform-session.ts");
  await revokePlatformSession(db, getWallet(cookie));

  const res = await (await wallet()).POST(postRedeem(cookie));
  assert.equal(res.status, 401, `a revoked session must not write: ${res.status}`);
  // The handler never ran: no wallet ledger entry was created for this customer.
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM pawspace_wallet_ledger WHERE customer_id=?").get(CUSTOMER).c, 0, "the refused write created no wallet ledger entry");
});

test("deactivating the identity binding -> the still-unexpired session cookie is refused 401 (session force-revoked)", async () => {
  const { db } = freshDb();
  const { cookie, bindingId } = await mintSession(db);
  const { revokeIdentityBinding } = await import("../lib/identity-binding.ts");
  // The account is deactivated at the binding level; the session row itself is still 'active' and unexpired.
  await revokeIdentityBinding(db, { id: bindingId, actorId: "security@pawspace.in", reason: "account deactivated" });

  const res = await (await wallet()).GET(getWallet(cookie));
  assert.equal(res.status, 401, `a session whose binding was deactivated must be refused: ${res.status}`);
  const body = await res.json();
  assert.equal(body.data, undefined, "no protected data leaks after binding deactivation");
});
