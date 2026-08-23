import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Release UI closure #19 reported one control finding:
//   CONTROL actor=founder route=/partner-app result=no_observable_effect text="↻"
// The refresh control was enabled under a staff/founder session even though every effect keyed on
// refreshKey exits immediately without a verified provider identity, so the click could not perform
// a meaningful refresh. The fix makes the control unavailable in that state. These tests evaluate
// the real guard expressions taken from source, rather than only matching their text, so a change
// that keeps the wording but breaks the behaviour still fails.

const source = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

const REFRESH_BUTTON = /<button[^>]*onClick=\{\(\) => setRefreshKey\(\(value\) => value \+ 1\)\}>↻<\/button>/g;
const NO_IDENTITY = null;
const IDENTITY_WITHOUT_SUBJECT = { subjectType: "provider", roleCode: "service_provider" };
const IDENTITY_EMPTY_SUBJECT = { subjectType: "provider", subjectId: "" };
const VERIFIED_PROVIDER = { subjectType: "provider", subjectId: "UAT-PROVIDER-1", roleCode: "service_provider" };

const attributeExpression = (markup, attribute) => markup.match(new RegExp(`${attribute}=\\{([^}]*)\\}`))?.[1];
// The expressions come from our own committed source; evaluating them is what makes these tests
// behavioural instead of textual.
const evaluateWithIdentity = (expression, identity) => new Function("identity", `return (${expression});`)(identity);

async function refreshButtons() {
  const page = await source("app/partner-app/page.tsx");
  const buttons = page.match(REFRESH_BUTTON) || [];
  return { page, buttons };
}

test("1. refresh is disabled without a verified provider identity", async () => {
  const { buttons } = await refreshButtons();
  assert.ok(buttons.length > 0, "the refresh control must still exist");
  for (const button of buttons) {
    const guard = attributeExpression(button, "disabled");
    assert.ok(guard, `refresh control must carry a disabled guard: ${button.slice(0, 90)}`);
    assert.equal(evaluateWithIdentity(guard, NO_IDENTITY), true, "no identity at all must disable refresh");
    assert.equal(evaluateWithIdentity(guard, IDENTITY_WITHOUT_SUBJECT), true, "an identity with no subjectId must disable refresh");
    assert.equal(evaluateWithIdentity(guard, IDENTITY_EMPTY_SUBJECT), true, "an empty subjectId must disable refresh");
  }
});

test("1b. the disabled state explains itself accessibly", async () => {
  const { buttons } = await refreshButtons();
  for (const button of buttons) {
    const title = attributeExpression(button, "title");
    assert.ok(title, "refresh control must carry an explanatory title");
    assert.equal(evaluateWithIdentity(title, NO_IDENTITY), "Verified provider sign-in required to refresh jobs");
    assert.equal(evaluateWithIdentity(title, VERIFIED_PROVIDER), "Refresh jobs");
  }
});

test("2. refresh is enabled with a verified provider identity", async () => {
  const { buttons } = await refreshButtons();
  for (const button of buttons) {
    const guard = attributeExpression(button, "disabled");
    assert.equal(evaluateWithIdentity(guard, VERIFIED_PROVIDER), false, "a verified provider must keep refresh usable");
  }
});

test("3. enabled refresh still increments refreshKey and refetches the provider job data", async () => {
  const { page, buttons } = await refreshButtons();
  for (const button of buttons) {
    const reducer = button.match(/setRefreshKey\((\(value\) => value \+ 1)\)/)?.[1];
    assert.ok(reducer, "refresh must still advance refreshKey");
    const advance = new Function(`return ${reducer};`)();
    assert.equal(advance(0), 1);
    assert.equal(advance(7), 8);
  }
  // The refresh path must remain nothing but the state advance: no toast or DOM side effect was
  // bolted on to satisfy the gate.
  for (const button of buttons) {
    assert.match(button, /onClick=\{\(\) => setRefreshKey\(\(value\) => value \+ 1\)\}/, "refresh must not gain a cosmetic side effect");
  }
  // Advancing refreshKey must still drive a real refetch of the provider's jobs.
  assert.match(page, /fetch\(`\/api\/partner-grooming-jobs\?providerId=\$\{encodeURIComponent\(identity\.subjectId\)\}&v=\$\{refreshKey\}`/, "the jobs fetch must still be keyed on refreshKey");
  assert.match(page, /\}, \[identity\?\.subjectId, refreshKey\]\);/, "the jobs effect must still re-run when refreshKey advances");
  assert.match(page, /if \(!identity\?\.subjectId\) return;/, "the effect's own identity guard stays in place");
  // The post-mutation refresh inside the lifecycle action is unrelated to the control and untouched.
  assert.match(page, /^\s{6}setRefreshKey\(\(value\) => value \+ 1\);$/m, "the lifecycle action's refresh must remain unguarded");
});

test("4. provider identity authorization is unchanged", async () => {
  const page = await source("app/partner-app/page.tsx");
  assert.match(page, /fetch\("\/api\/identity-session", \{ cache: "no-store" \}\)/);
  assert.match(page, /if \(body\.data\?\.subjectType !== "provider" \|\| !body\.data\.subjectId\) throw new Error\("Verified provider session required"\);/,
    "only a verified provider subject may become the page identity");
  assert.match(page, /if \(!response\.ok\) throw new Error\(body\.error \|\| "Verified provider session required"\);/);
  // No identity may be minted, defaulted or widened locally to make the control usable.
  assert.doesNotMatch(page, /setIdentity\(\{/, "identity must never be synthesised in the client");
  assert.doesNotMatch(page, /subjectType\s*[=!]==?\s*"(staff|founder|admin|associate|manager|finance)"/, "staff roles must not be accepted as provider identity");
  assert.doesNotMatch(page, /subjectId\s*[:=]\s*"[^"]+"/, "no hardcoded provider subject");
  assert.doesNotMatch(page, /\|\|\s*true\b/, "no authorization short-circuit");
  assert.doesNotMatch(page, /subjectType\s*\?\?\s*"provider"|subjectId\s*\?\?\s*"/, "no defaulted provider identity");
});

test("the closed finding needed no closure-harness change: the gate already skips disabled controls", async () => {
  // Documents why closure #19's finding clears without any exemption: the probe never treats a
  // disabled control as a wiring failure. Asserted, not modified.
  const harness = await source("scripts/release-ui-closure.mjs");
  assert.match(harness, /disabled: Boolean\(el\.disabled \|\| el\.getAttribute\("aria-disabled"\) === "true"\)/);
  assert.match(harness, /\.filter\(\(d\) => !d\.disabled && !d\.hidden/);
  // And no exemption was introduced anywhere in the gate for this finding.
  const classifier = await source("scripts/release-ui-control-classifier.mjs");
  // No identity verdict, and no identity value is ever read from the evidence.
  assert.doesNotMatch(classifier, /blocked_identity_precondition/, "no identity verdict may exist");
  assert.doesNotMatch(classifier, /evidence\.(identity|auth|rbac)\w*/i, "the classifier must never branch on identity evidence");
  assert.doesNotMatch(classifier, /↻|refresh/i, "no special case for the refresh control");
});
