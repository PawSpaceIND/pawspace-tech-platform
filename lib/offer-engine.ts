// This module previously held a full browser-persisted, client-only
// coupon/referral engine, disconnected from the real server-side systems in
// lib/coupon-governance.ts and lib/referral-governance.ts. That engine and
// its only UI (app/control/offers-control-panel.tsx) have been removed as
// confirmed-dead code - nothing rendered that panel from any nav.
//
// The two type aliases below are kept because app/mobile-app/coupon-field.tsx
// still imports them for its prop types. The real coupon check happens in
// lib/coupon-governance.ts, reached via
// lib/coupon-governance-client.ts's quoteGovernedCoupon.
export type PawspaceService = "Grooming" | "Dog Training" | "Boarding" | "Pet Sitting";
export type CustomerKind = "new" | "existing" | "subscriber";
