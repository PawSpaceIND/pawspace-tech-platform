# Deployed visual retest — 29 September 2026

## Provenance and disposition
The live Founder retest used staging revision `7008c8560a509078d10f8e75e83c6e9343125b2d`, deployment 36511803932, with Professional / Emerald + Gold / light. The 27 original findings now have 23 passing sampled states, one reopened finding (F-002), two partial checks (F-005 and F-012), and one blocked retest (F-019). This is not full-application sign-off.

F-005: current template records did not expose the original Verify with Meta action. F-012: representative static utility views passed, not the full cross-module scroll-state set. The combined CRM/handoff/pricing live retest was tool-blocked and was not retried through a substitute path.

The earlier customer UI-24, UI-25 and UI-26 were independently revisited in guest chat: navigation breaks words, the message placeholder is clipped, and excessive bottom spacing remains. The other 25 earlier customer/partner observations were not revalidated. A chat-source inspection command was blocked; no chat repair is claimed in this branch.

## Reopened F-002
The live Meet & Greet actions are readable, but long customer/request IDs paint across the adjacent format/price cells. Short separator-rich synthetic IDs in the original matrix did not expose this shape.

The new synthetic regression uses unbroken hexadecimal segments and checks every text rectangle against its own cell, full retained identifier text, and document-width containment at 390, 768 and 1440 pixels.

- Before repair: 2 failed (390/768), 1 passed (1440).
- Initial broad stack-wrapping candidate: 34 passed / 36 failed in the 70-case matrix because WhatsApp identifiers changed wrapping. This attempt was not shipped.
- Restricting the repair to request details exposed one retained ordinary-word wrapping regression. Giving that request column enough intrinsic width closed it without changing the assertion.
- Current focused proof: 4/4 passed, including the three new long-ID cases and the unchanged nine-table mobile case.
- Original guards: 84/84 passed, zero skips; 21 historical source baselines independently verified.

## Change and release boundary
One presentation class on Meet & Greet request details and its narrowly scoped CSS preserve original content and action bindings. Exact previous source hashes were verified before updating the affected presentation snapshots. Original imperative/event/JSX histories are not rebaselined. No API, business-rule, payment or permission source is changed.

Full 70-case verification and required hosted checks remain separate release gates. This branch is not merged or deployed. F-002 remains reopened on live staging until the follow-up is released and retested.

Live screenshots remain private on the authorized Mac at `Documents/PawSpace_V2_UI_Retest_2026-09-29`; none is committed to this public repository. Synthetic before/after logs are retained separately. No booking, payment, approval, outgoing call or message was submitted during the live pass.
