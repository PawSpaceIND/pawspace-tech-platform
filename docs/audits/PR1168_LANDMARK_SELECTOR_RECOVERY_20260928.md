# PR #1168 — Voice test locator recovery

The hardened browser job `109062238601` on candidate `bed7436d5a2a8ea5520b41245334ea4647a2a732` failed because `getByLabel("Use case")` matched the dropdown plus two newly descriptive table landmarks. This was a strict-locator ambiguity, not a failed calling-policy assertion.

Both existing Voice console suites now select the exact `combobox` role named “Use case”. No first-match fallback, index selector, removed assertion, retry increase or application-label rollback was introduced. The original policy-preview, disabled/enabled dial state, simulated request, audit, handoff, opt-out, retry, cancel and exact action-sequence assertions are retained.

Verification: both suites passed on desktop Chromium and mobile Chromium, **4/4 tests**, with mocked provider requests and no live dial. The four-width shared-table regression also asserts that the Use case combobox is unique despite the descriptive table landmarks. No application, API, payment or voice-provider implementation changes are part of this correction.

The exact published candidate still requires its refreshed hosted CI verdict; the older visual results are not silently carried forward.
