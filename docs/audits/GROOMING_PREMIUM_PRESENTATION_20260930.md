# Grooming premium presentation — phase 1 draft

User authorized implementation on actual existing steps, strictly presentation only. Dependent base: PR1209 repaired head ae1edc2aa859ece10795b910da1d6f644afbcf2f. PR1211 utility-flow repair remains independent; shared presentation.module.css is not edited here. No Taxi/partner/staff addition in this phase.

## Exact scope and invariants

Only app/v2/grooming/grooming.module.css is appended, plus that owned stylesheet key in inbox-workspace-contract, partner-services-presentation-contract and ui-display-truth-contract fixtures. CSS digest8f1d26f61abc524bf1afea5f4bbe4f349274942fb2f6ed88d22ab3a37b21bf0a →5addeb9c961a774aa42c3d6a795a24a397eb7daf6c4c2d134989428b1943c833. Entire base stylesheet remains an exact prefix. app/v2/grooming/page.tsx byte comparison against the base passed; all component files, event handlers, state transitions/effects, requests/APIs, validation, pricing, payment timing, professional dependency, provider assignment and reservation authority are unchanged. Existing four step navigation Pets→Package→Address→Time & review unchanged. No new state machine, synthetic progress state, business copy or label changes.

## Visual implementation

- Compact hero with28–40px responsive heading,14–15px body, stronger separation from form.
- Existing step sections use consistent solid theme surfaces, spacing and existing Professional/Fun radius tokens;22px desktop/20px phone headings.
- Existing numbered progress controls >=48px with clearer current outline, wrap-safe labels and dashed disabled borders. Existing ARIA/disabled wiring unchanged.
- Larger pet/provider cards, calmer package hierarchy and gaps, existing selection styles retained.
- Address inputs remain full-width on phones; coverage CTA occupies a separate row at wider sizes. This selector is journey-scoped and cannot rearrange summary payment choices.
- Summary wraps long names/address safely, aligns facts, uses tabular price numerals and a >=56px wrapping CTA. Contrast fix preserved. <=1100px summary remains in document flow.
- Existing Professional/Fun art visibility, fonts,3palettes/light/dark/system tokens retained. No image asset, tokens, root styles or checkout CSS edited.

## Validation and remaining gates

100focused existing source/theme/chat/preservation checks passed0fail/skips. Includes exact protected source guards, PostCSS/scoping/original prefix checks and executed chat component tests. Explicit before/after entire Grooming component comparison passed. git diff --check passed. No new mirror-only tests, heavy builds/install or Mac browser. These are source verification, NOT actual browser QA. No CTR/booking-completion uplift claimed.

Cloud owner/captain must render actual Grooming preview at320/391/485/768/1165/1440 CSS px, both styles/allpalettes/modes. Confirm four existing step buttons preserve enabled/disabled/title/current state and focus/scroll behavior; type/spacing at200%zoom; no page overflow/date strip clipping; touch sizes and keyboard focus; empty/loading/error/long names/addresses; package/provider selections; coverage and summary layout; disabled/reserving CTA; saved state preserved across theme switch. Use synthetic intercepted requests only, no real reservation/payment/dispatch. Include PR1211 preview rules for mobile hit-testing, label combined preview dependencies, and verify the CTA right edge at the reported485×757 scroll position reaches the CTA. Capture actual before/after screenshots; no rendered certification until these checks run. Partner/staff refinements follow only after Grooming QA and exact file ownership check.
