import base from "../playwright.config";

// Gated Modern Concierge acceptance (Stage C). Used only with `--config e2e/concierge.playwright.config.ts` against a
// sandbox started with NEXT_PUBLIC_PAWSPACE_CONCIERGE_AVAILABLE=true; the main config and its protected digest are untouched.
export default { ...base, testMatch: ["e2e/v2-concierge-acceptance.spec.ts"] };
