# PR #1168 — second-review dispositions

The following CodeAnt suggestions were verified against `a0b291147193a6a6f612edaa32a731fb6cb67212`.

| Comment | Disposition | Evidence / change |
|---|---|---|
| 4125199835 | Addressed | Sign placeholders, uncontrolled defaults, read-only and pattern constraints, and form routing/configuration fields. Executable mutation tests cover changed values. |
| 4125199845 | Hardened; stated bypass was overstated | Replacing an existing direct fetch already removed a required signature and failed. Qualified `window`, `globalThis`, `self` and literal bracket-fetch calls are now signed too; target and body mutations are tested. |
| 4125200193 | Not reproduced; no CSS change | The old two-column rule is on line 1; the new 1.4:1 rule follows it. Only the later max-850px media rule stacks the columns. Chromium tests now assert the actual 1.4 ratio on desktop. |
| 4125202152 | Intentional responsive behavior; no CSS change | The opt-in staff stats grid already used auto-fit with a 180px floor before this PR. It is not document-global. Seven populated cards remain present and contained at 390, 768, 1440 and 1920 pixels; they wrap at 1440 and occupy one row at 1920. |
| 4125202168 | Addressed | Shared table landmarks derive meaningful distinct names from their existing column headers, without changing table values or callbacks. Renderer/browser checks and a current-consumer inventory detect duplicate names. |
| 4125202791 | Addressed | One pure resolver supplies the browser origin and server port. Custom loopback origins work; conflicting ports and unsupported origins fail early. The custom-port browser run passed. |
| 4125204781 | Addressed | Dedicated CI fetches the pinned original commit and executes a historical verifier before checking the current sources. It fails if original data is missing or altered. It does not trust a freshly edited fixture as historical evidence. |
| 4125205784 | Addressed | The complete JSX collector now signs non-style literal and boolean props as well as executable expressions and spreads. Mutation tests include disabled/type/formAction and unknown literal totals. |

## Baselines

The original nineteen imperative hashes remain unchanged. Literal-aware JSX originals and expanded control signatures are extracted from the same pinned original Git objects. Exact reversible presentation deltas include semantic table wrappers/names, TDS headings, explicit empty states and unchanged Atlas response handoff. The existing shorter wallet placeholder is recorded as one explicit reviewed placeholder delta; it is not silently accepted into the historical event baseline.

`node scripts/ui-audit-history.mjs` verifies twenty-one historical application sources at `89d483d971b1ca1ceeaeb96bbff91898168081f2`. The CI step fetches this exact commit and does not skip or continue after a verification failure. Unit tests exercise altered baseline metadata, self-updated expectations and missing historical evidence.

## Verification checkpoint

- Presentation/source subset: 361/361 passed, zero skipped.
- Focused guard, rendering and unchanged static-test ratchet cases are included in that count, not additive.
- Custom-port browser proof: 5/5 passed, including three-width Tracking and four-width populated statistics/landmark checks.
- TypeScript, ESLint and direct historical verification passed.
- Updated full browser inventory: 67 cases; the exact local/hosted result is recorded on the PR when complete.

No payment, tax, booking, identity, API or library business behavior is changed by these second-review corrections. The two investigated layouts were retained rather than altered on an unsupported claim. Remaining customer/partner, role/dialog and physical-device audit scope is unchanged.
