import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (p) => fileURLToPath(new URL("../" + p, import.meta.url));
const read = (p) => readFileSync(at(p), "utf8");

// Every one of these guards a Gate A blocker: a defect that ends a human tester's session or
// corrupts the feedback the session produces. They are cheap to keep and expensive to rediscover.

test("every thrown render error has a recovery boundary, not a white page", () => {
  for (const boundary of [
    "app/error.tsx",
    "app/global-error.tsx",
    "app/not-found.tsx",
    "app/loading.tsx",
    "app/mobile-app/error.tsx",
  ]) {
    assert.ok(existsSync(at(boundary)), `${boundary} is missing — a thrown error renders a blank page`);
  }
  // global-error replaces the failed root layout, so it must bring its own document shell.
  const globalError = read("app/global-error.tsx");
  assert.match(globalError, /<html/, "global-error must render its own <html>");
  assert.match(globalError, /<body/, "global-error must render its own <body>");
  // A boundary that imports the design system can fail for the same reason the page did.
  assert.doesNotMatch(globalError, /^import /m, "global-error must have no imports");

  // Each boundary must offer a way out, or the tester is still stuck.
  assert.match(read("app/error.tsx"), /reset/, "the route boundary must offer a retry");
  assert.match(read("app/mobile-app/error.tsx"), /reset/, "the customer app boundary must offer a retry");
});

test("the customer app cannot be pinned on a blank screen by a hung request", () => {
  const page = read("app/mobile-app/page.tsx");
  // The whole app is gated behind sessionChecked. fetch() has no default timeout, so an unbounded
  // probe left /mobile-app rendering an empty <main> forever — indistinguishable from a crash, and
  // not catchable by any error boundary because nothing was ever thrown.
  assert.match(page, /AbortController/, "the session probe must be bounded");
  assert.match(page, /SESSION_PROBE_TIMEOUT_MS/, "the timeout must be a named constant");
  assert.doesNotMatch(
    page,
    /await fetch\("\/api\/identity-session"/,
    "the identity probe must go through the deadline helper",
  );
  // And the loading state must look like loading rather than like a broken page.
  assert.match(page, /Loading your PawSpace/, "the gate must render a visible loading state");
});

test("the notifications FAB does not cover the booking call to action", () => {
  const css = read("app/globals.css");
  // Both were pinned at bottom:18px with the FAB at z-index 80 over the bar at 16, and
  // "Confirm booking" is the bar's last flex child — so the FAB landed on it below ~950px.
  assert.match(css, /body:has\(\.checkout-bar\) \.ps-order-fab/, "the FAB must move clear of the bar");
  assert.match(
    read("app/components/order-notification-center.tsx"),
    /className="ps-order-fab"/,
    "the FAB needs a stable hook for that rule",
  );
});

test("payment tables that only migrations declare are created at runtime", () => {
  const lifecycle = read("lib/financial-lifecycle.ts");
  // wrangler applies ./migrations; this repo keeps them in drizzle/ with no migrations_dir set, so
  // no deploy path applies them. These two tables had no other creator and did not exist in staging.
  assert.match(lifecycle, /ensureFinancialLifecycleTables/);
  for (const table of ["payment_intents", "financial_outbox"]) {
    assert.match(
      lifecycle,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`),
      `${table} must have a runtime creator`,
    );
  }
  // The runtime shape must keep the migration's money constraints, or the two diverge silently.
  assert.match(lifecycle, /amount_paise INTEGER NOT NULL CHECK \(amount_paise > 0\)/);
  assert.match(lifecycle, /dedupe_key TEXT NOT NULL UNIQUE/);
  assert.match(lifecycle, /UNIQUE\(customer_id, booking_id, idempotency_key\)/);

  // A fallback table without the migration's indexes makes every reconciliation and payment lookup a
  // full scan. Both must be NON-unique: 0017 created payment_id UNIQUE, 0018 dropped and recreated it
  // plain for split intents, so the final replayed state is what a runtime creator has to match.
  assert.match(lifecycle, /CREATE INDEX IF NOT EXISTS idx_payment_intents_payment_id/);
  assert.match(lifecycle, /CREATE INDEX IF NOT EXISTS idx_payment_intents_booking/);
  assert.doesNotMatch(
    lifecycle,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_payment_id/,
    "0018 removed that uniqueness on purpose; re-imposing it would reject legitimate split intents",
  );
});

test("customer screens keep honest disclosures and drop internal vocabulary", () => {
  const grooming = read("app/mobile-app/grooming-flow.tsx");
  // Internal jargon on a customer CTA teaches testers the wrong words for what they are reporting.
  assert.doesNotMatch(grooming, /Create canonical UAT booking/);
  assert.match(grooming, /Confirm booking/);
  // But the disclosures that tell a tester no real money moved are TRUE and must survive: removing
  // them to look production-ready would make the build lie about what it just did.
  assert.match(grooming, /does not move live money/);
});
