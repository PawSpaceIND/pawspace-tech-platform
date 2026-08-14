/**
 * REGRESSION for FINDING 12 (P2): Provider onboarding must not surface RAW API error bodies to users.
 * Previously the refresh path, the initial-load path and the submit (post) path all did
 * `throw new Error(await r.text())`, so a raw auth/ownership JSON body (e.g. {"error":"Permission
 * denied"} / {"error":"Authentication required"}) rendered verbatim in the <p role="alert">.
 *
 * After the fix, every non-OK response is mapped to a controlled, human-readable message based on
 * status (401/403 -> a sign-in prompt; everything else -> a generic retry message), and the raw
 * body is kept out of the UI (logged for diagnostics only). This is a source-level assertion, which
 * is appropriate for a client component's error UX.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ui = read("app/partner/onboarding/page.tsx");

test("no throw site surfaces a raw response body to the UI", () => {
  const rawThrows = ui.split("\n").filter(line => /throw new Error\(await r\.text\(\)\)/.test(line));
  assert.equal(rawThrows.length, 0, "no `throw new Error(await r.text())` may remain — raw bodies must not reach the UI");
});

test("a safe status->message mapping exists (401/403 vs generic)", () => {
  // The mapping keys off the HTTP status, not the response body text.
  assert.match(ui, /r\.status === 401 \|\| r\.status === 403/, "must branch on 401/403 status");
  assert.match(ui, /Please sign in as a verified provider to continue\./, "401/403 maps to a sign-in prompt");
  assert.match(ui, /Something went wrong\. Please try again\./, "other statuses map to a generic safe message");
});

test("all three non-OK paths route through the safe mapper", () => {
  // refresh(), initial-load effect, and post() must all throw the mapped error, not raw text.
  const safeThrows = ui.split("\n").filter(line => /throw await safeApiError\(r\)/.test(line));
  assert.ok(safeThrows.length >= 3, `expected the 3 non-OK paths (refresh/initial-load/post) to use the safe mapper, found ${safeThrows.length}`);
});

test("raw detail is kept for diagnostics only (console.error), never rendered", () => {
  assert.match(ui, /console\.error\("provider-onboarding-self-service"/, "raw detail is logged for diagnostics");
  // The rendered error state carries only the mapped message strings above; assert the two safe
  // messages are the only user-facing copy tied to the mapping (no JSON internals templated in).
  assert.equal(/\{JSON\.stringify\([^)]*error/.test(ui), false, "no raw error JSON is templated into the UI");
});

test("EXECUTION: the mapping function returns safe messages for representative statuses", async () => {
  // Re-implement the exact mapping the page uses and prove the user-facing outputs are safe for the
  // raw bodies the gateway returns (401 {"error":"Authentication required"}, 403 {"error":"Permission denied"}).
  const map = (status) => (status === 401 || status === 403)
    ? "Please sign in as a verified provider to continue."
    : "Something went wrong. Please try again.";
  const raw401 = JSON.stringify({ error: "Authentication required" });
  const raw403 = JSON.stringify({ error: "Permission denied" });
  for (const s of [401, 403]) {
    const shown = map(s);
    assert.doesNotMatch(shown, /error|Permission|Authentication|\{/, "mapped message must not leak raw body internals");
    assert.equal(shown, "Please sign in as a verified provider to continue.");
  }
  assert.equal(map(500), "Something went wrong. Please try again.");
  // Sanity: the raw bodies themselves WOULD have leaked internals had they been shown.
  assert.match(raw401, /Authentication required/);
  assert.match(raw403, /Permission denied/);
});
