import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// The pay-after-service payment request, once its link has expired.
//
// getPostServicePaymentRequest reports an elapsed link as status "expired" with collectable:false.
// The Partner app told the partner to "create a governed replacement request" in exactly that state -
// but the only create button lived in the branch that renders when NO request exists, so the sentence
// named an action the screen did not offer. A completed pay-after-service job whose link had aged out
// had no way forward from the app at all.
//
// The expired state below is produced by the real exported read, not asserted about.
// ---------------------------------------------------------------------------

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
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const page = readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
const BOOKING = "BK-PAYAFTER-1";
const PAYMENT = "PAY-PAYAFTER-1";
const PROVIDER = "groom_arun";

/** Seed one pay-after-service request whose link expiry is `expiresAt`, then read it back for real. */
async function readRequest({ expiresAt, paymentStatus }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
  await reconciliation.ensurePaymentReconciliationTables(db);

  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'INR','upi','pay_after_service',?,?,1,1)")
    .run(PAYMENT, BOOKING, "CU-1", 1499, 1499, paymentStatus, `idem-${paymentStatus}-${expiresAt}`);
  sqlite.prepare("INSERT INTO post_service_payment_requests (id,booking_id,payment_id,provider_id,amount,currency,status,payment_path,qr_payload,expires_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'INR','awaiting_payment',?,?,?,?,1,1)")
    .run("plink_uat_1", BOOKING, PAYMENT, PROVIDER, 1499, "https://rzp.io/i/sandboxlink", "upi://pay?pa=sandbox", expiresAt, "ops.one@pawspace.in");

  return reconciliation.getPostServicePaymentRequest(db, { bookingId: BOOKING, providerId: PROVIDER });
}

test("a live link reads back collectable, with the expiry the partner can quote", async () => {
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const view = await readRequest({ expiresAt, paymentStatus: "pending" });
  assert.equal(view.status, "awaiting_payment");
  assert.equal(view.collectable, true);
  assert.equal(view.expiresAt, expiresAt, "expiresAt is returned, and is now rendered rather than dropped");
  assert.equal(view.liveCapture, false);
});

test("an elapsed link reads back as expired and not collectable", async () => {
  const expiresAt = Date.now() - 60 * 1000;
  const view = await readRequest({ expiresAt, paymentStatus: "pending" });
  assert.equal(view.status, "expired", "this is the state the app had no action for");
  assert.equal(view.collectable, false);
});

test("a settled payment reads back as settled, which must not offer a replacement link", async () => {
  const view = await readRequest({ expiresAt: Date.now() + 60_000, paymentStatus: "captured" });
  assert.equal(view.status, "captured");
  assert.equal(view.paymentStatus, "captured");
  assert.equal(view.collectable, false,
    "captured is not collectable either, so the two non-collectable states need different copy");
});

test("the expired branch offers the replacement it names, and the settled branch does not", () => {
  assert.match(page, /paymentExpired = Boolean\(paymentRequest && paymentRequest\.status === "expired"\)/);
  // The three settled statuses now live in one module-scope constant rather than inline here, so this
  // asserts the judgement instead of the spelling. The list itself is pinned in the refunded test below.
  assert.match(page, /paymentSettled = Boolean\(paymentRequest && SETTLED_PAYMENT_STATUSES\.includes\(paymentRequest\.paymentStatus\)\)/);
  assert.match(page, /Create replacement payment request/, "the named action must exist on screen");
  // The settled copy is reached before the replacement branch, so a captured payment cannot offer one.
  const settledAt = page.indexOf("no further collection is due");
  const replacementAt = page.indexOf("Create replacement payment request");
  assert.ok(settledAt > 0 && replacementAt > 0);
  assert.ok(settledAt < replacementAt, "the settled branch must short-circuit before the replacement branch");
});

test("the request's expiry and capture mode reach the screen", () => {
  assert.match(page, /whenMs\(paymentRequest\.expiresAt\)/, "expiresAt was declared and never rendered");
  assert.match(page, /paymentRequest\.liveCapture \?/, "liveCapture was declared and never rendered");
});

test("a refunded pay-after-service booking is never offered as collectable", () => {
  // CodeAnt flagged this and it was right. The settled list governs collectAtDoor and paymentSettled,
  // but the section gate tested only for "captured", so a REFUNDED booking rendered "Payment due after
  // service" and offered to create a collection link against money already returned to the customer.
  const page = readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");

  const settled = page.match(/const SETTLED_PAYMENT_STATUSES = \[([^\]]*)\]/);
  assert.ok(settled, "the settled-status list must exist as one named constant");
  for (const status of ["captured", "refunded", "partially_refunded"])
    assert.match(settled[1], new RegExp(`"${status}"`), `${status} must count as settled`);

  // Declared at module scope so every use site follows the declaration; an in-component const sat
  // below one of its own callers and would have thrown a temporal-dead-zone ReferenceError.
  assert.match(page, /^const SETTLED_PAYMENT_STATUSES/m, "must be module-scoped, not inside the component");

  const gate = page.match(/selected\.status === "completed" && selected\.payment\.mode === "pay_after_service" && ([^&]*)&&/);
  assert.ok(gate, "the pay-after-service section gate must still exist");
  assert.match(gate[1], /!SETTLED_PAYMENT_STATUSES\.includes\(selected\.payment\.status\)/,
    "the gate must exclude every settled status, not just captured");
  assert.doesNotMatch(gate[1], /!== "captured"/,
    "testing captured alone lets a refunded booking offer a collection link");

  // Every judgement of settlement goes through the one list.
  assert.equal((page.match(/\["captured", "refunded", "partially_refunded"\]/g) || []).length, 1,
    "the status list must not be duplicated inline anywhere");
});

test("a successful earnings load clears the banner a previous failure left behind", () => {
  const page = readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
  const effect = page.slice(page.indexOf('if (tab !== "earnings"'), page.indexOf("const [mediaAssets"));
  assert.match(effect, /setError\(problem instanceof Error/, "the failure path writes the shell error banner");
  const success = effect.slice(0, effect.indexOf("}).catch("));
  assert.match(success, /setError\(""\)/,
    "the success path must clear it, or a retry shows fresh figures beside a stale failure");
});
