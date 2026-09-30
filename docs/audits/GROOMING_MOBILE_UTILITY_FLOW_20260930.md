# Grooming mobile utility flow

Parent/cloud UAT confirmed at 485×757 CSS px, Professional/Emerald, Address step:
CTA x45 y556.28125 width395 height52; Appearance x365 y565 44×44; updates x425 y565 44×44.
Vertical overlap43.28125px, horizontal overlap44/15px. elementFromPoint(387,583) hit Appearance and (432,583) hit order updates. No CTA was pressed. Mac browser was not used.

Source: presentation.module.css fixes utilities bottom148px for Grooming's hero marker, while form actions scroll beneath them. Root layout already renders both utility components after the page/footer. This patch makes both relative/in-flow only at <=820px while the V2 Grooming address marker exists, restores the Appearance label, and retains >=44px controls. No component, handler, booking/payment code, tokens or other routes edited. Utilities are reached by scrolling to the footer; this discoverability tradeoff requires cloud review. Open notification dialog remains an intentional overlay; verify close and Appearance remain reachable after closing it.

Open PRs1210/1209/1208/1207/1206/1205/1204/1203/1201/1199 checked through GitHub PR diffs: none edits presentation.module.css. Base main7eedbfb0ae63f5f2d7787ec4a6b2034412c4d40d. PR1209 contrast remains separate.

Validation: 50 existing focused theme/preservation checks passed, zero failures/skips; diff check passed. Original stylesheet prefix preserved; no new mirror-only tests. No build/install/Mac browser run. Actual rendered layout and hit testing pending cloud UAT; no release approval claimed.

Cloud retest: preview exact patch at320/391/485/768 and desktop821/1165px, both styles/allpalettes/modes. At reported485×757 position and throughout each form step, use rectangles/elementFromPoint to confirm CTA center/right edge hits CTA. Check page width/no horizontal overflow, controls >=44px, keyboard tab/focus, Appearance dialog and notification open/close/empty/loading/error layout. Preserve selected pet/package/address/slot; no payment or booking submission. Confirm consent visible/dismissed, footer and checkout states; rule deliberately stops applying when address marker unmounts so existing checkout layout remains intact. If injecting CSS overlay, translate CSS-module :global wrappers to plain selectors and label it preview, not deployed evidence.

## Preservation digest repair

Head2261f805d7dfc3e1553d0d30cb39652a239ad1f4, synthetic mergea6266e5, failed run36709510823/job109867654941 before browser rendering. One inline digest in tests/ui-chat-presentation.test.mjs expected1dbf3855516d0899bf9a57e8b8f1a6be203df7778df537b8cc38ca54644e338c; owned stylesheet SHA256 is3a201fab2e8db78e646277e899222fec8528e441f529e8ae3babbc75fafed5ef. Local test reproduced that failure. Search found no additional preservation entries for this digest. Update only that exact stylesheet digest, with an explanatory comment; all assertions/chat sources and the23-lineCSSappend remain intact. User/captain instruction explicitly covers owned presentation digest scope. Focused rerun63passed0failed/skipped; diff check passed. Fresh hosted browser gate remains required, no rendered pass inferred from source checks.
