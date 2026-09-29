# PR #1168 — reviewed presentation and guard corrections

Review: CodeRabbit `5342126650`, against `fc3b7aa0f42e25c37a4b082706742c5a822c084c`.

## Corrections

| Review comment | Verified problem | Correction and evidence |
|---|---|---|
| 4124963581 | Ordered-list items after a gap were renumbered | Every ordered item now retains its numeric `value`. Executed rendering asserts 3, 5, 5, 1; browser probes inspect those same values. |
| 4124963591 | Unfenced repeated spaces were collapsed | The formatter preserves `pre-wrap`; browser probes assert both the computed whitespace mode and exact repeated-space text. |
| 4124963598 | Multiple table regions had identical accessible names | Reminders and Finance now use distinct names, retaining the horizontal-scroll hint and keyboard focus. Three-width browser probes verify each named region. |
| 4124963605 | Non-CI runs could reuse a stale local server | Audit configuration now refuses server reuse. Each audit starts the current checkout, or fails if its port is occupied. |
| 4124963612 | Unknown executable JSX props and children were erased from the guard | The complete imperative signature now also signs ordered JSX expressions and spreads. Mutation tests reject changed custom `total` props, expression children, nested callbacks, spreads and conditionals. |
| Review nit: control identity | Sorting handlers could conceal a swap between controls | Each event signature includes its control's preorder identity and tag. Swapped handlers now fail while inserting a purely visual wrapper still passes. |

The formatter also keeps lone or unfinished emphasis/code markers as literal text instead of dropping them.

## Historical evidence is retained

The original imperative-program hashes remain unchanged in `ui-audit-logic-contract.json.files` and are still asserted independently. `jsxOriginal` is extracted from the actual original commit `89d483d971b1ca1ceeaeb96bbff91898168081f2`, not accepted from the repaired source. Thirteen files need exact, reversible expression deltas: added table focusability, semantic TDS headings, explicitly checked empty states, and passing the same Atlas response text to the formatter. Every other non-style JSX expression must match its original order and value.

The event baseline is regenerated with the stronger identity-aware algorithm against that original commit, and every current file was compared successfully against it before writing the fixture. Existing request/event checks, runtime checks and the unchanged static-test ratchet remain active. Only the reviewed Reminder accessible-label source hashes were refreshed in legacy snapshots, with exact HEAD-preimage validation.

## Verification checkpoint

- Focused guards, renderer and unchanged static-test ratchet: 79/79 passed, including both module-hook modes.
- Broader presentation/source subset: 354/354 passed, zero skipped. The focused cases are included; do not sum the counts.
- Dedicated browser review corrections: 3/3 passed at 390, 768 and 1440 pixels.
- TypeScript and ESLint on the revised sources: passed.
- Full updated browser run: 63/63 passed locally with zero retries. The hosted verdict must be refreshed for the published candidate.

These are UI/display and regression-guard corrections. No booking, payment, API, permission or library business implementation is changed. The wider customer/partner and physical-device audit remains open; this document is not production or application-wide sign-off.
