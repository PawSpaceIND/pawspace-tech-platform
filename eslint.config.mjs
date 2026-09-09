import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // PR #598 restores guest-draft hydration in these mobile flows. The synchronous
  // hydration setters are intentional: they restore one session-scoped snapshot
  // before the customer can continue the booking. Keep the exception narrowly
  // scoped to the two restored flows instead of weakening the repository rule.
  {
    files: ["app/mobile-app/grooming-flow.tsx", "app/mobile-app/pet-manager.tsx"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // `useCoverage` in the converged discovery screen is an event callback, not a
  // React hook. Preserve the #598 API while keeping hooks enforcement elsewhere.
  {
    files: ["app/mobile-app/premium-discovery-home.tsx"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
