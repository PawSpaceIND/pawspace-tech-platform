# Grooming summary foreground pairing

Base: main `7eedbfb0ae63f5f2d7787ec4a6b2034412c4d40d`, confirmed through GitHub on 30 September 2026.

## Confirmed finding

The parent relayed cloud-browser measurements at 1165 CSS px, Emerald / System-light, in Professional and Fun: summary labels `rgb(85,107,99)` on `rgb(1,38,31)` had 2.83:1 contrast; the large bold price `rgb(135,80,6)` on the same background had 2.45:1 contrast. These fail the usual 4.5:1 normal-text and 3:1 large-text targets. This author did not independently operate that cloud browser or export its screenshots.

Source explains the finding: `.summary` is filled with `--brand-primary`, while summary label overrides use `--brand-muted` and price/heading accents use `--brand-warning`. Those foregrounds belong to ordinary surfaces, not this dark primary surface.

## Bounded change

Append one summary-scoped rule to `app/v2/grooming/grooming.module.css`. Pair summary-top labels and badge, pet subtitle, row labels, price label/total and price annotations with the existing `--brand-on-primary`. Preserve the dark summary surface, all styles/palettes and the original stylesheet prefix. No new global tokens, TSX, handlers, requests, booking guards or business wording.

Open PR file ownership was checked for #1194, #1199, #1201, #1203, #1204, #1205, #1206 and #1207; none owns this stylesheet. Original protected-source manifests remain unchanged because this is an allowed scoped presentation append, not a protected-source mutation.

## Verification

- `node --test tests/ui-theme-convergence.test.mjs tests/customer-theme-system.test.mjs tests/customer-partner-theme.test.mjs`: 50 passed, zero failed/skipped. Includes original stylesheet preservation, scoped CSS parsing, protected application exact-byte checks and existing AST/data-flow guards. These are local source/preservation checks; they are not live browser contrast certification.
- Executed PostCSS token extraction and relative-luminance calculations over Professional/Fun × Emerald/Purple/Coral × light/dark: 12 combinations pass 4.5:1 with on-primary. Expected primary colours were asserted to prevent a fallback from masking palette selection. Ratios: Emerald 16.17:1; Purple 4.92:1; Coral 5.35:1. Primary/on-primary tokens are unchanged across these modes; system follows the resolved mode. This verifies token pair arithmetic, not rendered cascade or layout.
- The old measured Emerald pairs independently calculate to 2.83:1 and 2.45:1.
- `git diff --check`: passed.
- No install, large local build, whole suite, deployment, customer/order/payment mutation or Mac browser action.

## Remaining visual gate

Cloud UAT owns actual screenshots and rendered retest. Verify the appended rule's computed foreground on the real summary nodes, all offered palettes/modes and both styles, at narrow mobile and desktop; confirm switching appearance preserves pet/package/address/slot and that no content is obscured. Parent messaging currently returns “An earlier turn submission is not yet confirmed”, so retest coordination could not be delivered through that tool in this turn. Do not treat arithmetic as rendered proof.

Separate next finding: at 485 CSS px, floating Appearance/order-update bubbles overlap the right end of Check service area. This involves different floating utility selectors and is deliberately excluded from this contrast fix. Preserve all form handlers in a separately reviewed patch.

Draft only. Exact-head hosted CI and cloud render remain integration gates. No merge or deployment is included.
