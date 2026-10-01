# Current-main theme audit — source verified, visual QA pending

Fresh fetch main: 257fb5968d5ef52e7f33b2a18a429e83a83c7ad0. Isolated theme-consistency worktree. Existing Account/Training and captain1209 untouched. No browser, build, publication, manifest edits or account sync.

| Scope | Source coverage | Remaining qualification |
|---|---|---|
| Root/all routes | Root PawSpaceAppearance owns html data-paw-style/theme/mode; global design system tokens | Hydration applies preferences after first paint; screenshots pending |
| V2 customer | presentation canvas/brand palette inherits three palettes, mode, font and radii; native shell stays under root | Individual screen overrides need rendered matrix; no blanket completion claim |
| Standalone customer services | Seven ps-unified-service layouts and shared unified theme; Grooming root special selector | Existing shared bridges resolve current root tokens |
| Mobile customer | Local theme/mode state, same storage keys/event, local data-theme/mode plus root token bridge | Platform default read by root not mobile; legacy isThemeId accepts retired palettes; event detail ignored when storage unavailable. Source mismatch; exact visual consequences unrendered |
| Partner/partner-app | workspace-convergence inherits paw tokens, style scale; sidebar on-primary override already present | Not a new sidebar defect |
| Driver/host/trainer/walker/sitter | PartnerModule composes brand palette; colors/forms/radii scoped, mode aliases | Actual authenticated states unseen |
| Staff | 69 source files use StaffWorkspace/StaffModule; workspace bridge maps staff variables; admin/control/crm layouts defer to pages | Does not establish every route/state visually covered |
| Staff shared UI cards/buttons/badges | Console hardcoded ds radius 16/10 overrides root Fun radii | Confirmed source gap; prepared token-only local patch |
| Training Operations | Active TrainingPanel imports admin stylesheet with later scoped staff overrides | training-ops.module.css is unused; do not patch obsolete colors |

Preferences are device-local: pawspace.customer.theme, pawspace.customer.appearance, pawspace.visual-style. pawspace.platform.default-theme is a local default plus build env fallback. Same-window pawspace-appearance-change and cross-document storage listeners propagate changes; OS media listener resolves System. Global root component persists across client route transitions; preference reload occurs on page loads. Portal re-locates staff utility slot using pathname/MutationObserver. No server account storage. Storage-disabled root chooser honors CustomEvent detail; mobile listener currently reads storage only.

Professional and Fun share font/palette semantics; global Fun changes radii (24/18, scale1.35), Professional 16/12/1. Shared customer mobile desktop width also depends on style. Selected style must not imply alternative business flows.

Priority: (1) captain review local staff radius token patch and fresh-source ownership/guard digests, then UAT Professional/Fun both modes/palettes on relocation-enquiries + UI cards/buttons/badges; (2) coordinate mobile preference normalization/event-detail fallback with mobile/voice owner, no new keys; (3) render authenticated customer/partner/staff screen/error/form matrix before naming remaining color mismatches. Hardcoded semantic status colors/logo white surfaces are not automatically palette defects.

Local patch changes only two declarations in staff-console.module.css: full radius -> paw-control-radius; lg -> paw-card-radius. Professional controls become12px (formerly10); cards remain16. Fun controls18/cards24. No component/handler/API/state edits. New tests verify actual consuming CSS and reverse exact changed declaration to original hash. Visual QA pending; no pixel or accessibility acceptance claimed.

Fresh authorized GitHub open PR lookup returned1209/1207; authoritative changed filename lists show neither edits staff-console.module.css.1207 touches staff-console-page-contract fixture, so any guard refresh must be coordinated. No manifests changed here.
