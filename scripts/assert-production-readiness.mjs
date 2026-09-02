#!/usr/bin/env node
// Hard, unskippable production-readiness gate. Run BEFORE bundling or deploying.
//
// It reads the ambient environment (process.env), asks lib/production-readiness-enforcement.mjs whether
// every critical subsystem is on a live, non-mock, non-fallback driver, and EXITS NON-ZERO — refusing the
// build/deploy — if any blocking violation exists. There is deliberately no --force, --skip, or override
// flag: a gate you can wave past is not a gate.
//
// Outside a production profile (PAWSPACE_DEPLOYMENT_ENV / NODE_ENV / DEPLOYMENT_PROFILE = production) the
// gate is inert and exits 0, so it is safe to run in any pipeline; it only bites in production.
//
// Usage:
//   PAWSPACE_DEPLOYMENT_ENV=production node scripts/assert-production-readiness.mjs
//   node scripts/assert-production-readiness.mjs --require-production   # fail if NOT a production profile
import { evaluateProductionReadiness, ProductionReadinessError } from "../lib/production-readiness-enforcement.mjs";

const requireProduction = process.argv.includes("--require-production");
const report = evaluateProductionReadiness(process.env);

if (!report.enforced) {
  if (requireProduction) {
    console.error("Production-readiness gate expected a production profile, but none was detected.");
    console.error("Set PAWSPACE_DEPLOYMENT_ENV=production (or NODE_ENV / DEPLOYMENT_PROFILE) before this step.");
    process.exit(1);
  }
  console.log("Production-readiness gate is inert: this is not a production profile. Nothing to enforce.");
  process.exit(0);
}

const passed = report.checks.filter((check) => check.ok).length;
console.log(`Production-readiness gate — profile=production (${report.signals.join(", ")})`);
console.log(`  ${passed}/${report.checks.length} checks passed, ${report.violations.length} blocking, ${report.warnings.length} warning(s).`);

if (report.warnings.length) {
  console.log("\nWarnings (non-blocking):");
  for (const warning of report.warnings) console.log(`  ! [${warning.subsystem}] ${warning.code}: ${warning.detail}`);
}

if (report.violations.length) {
  // Build the same unrecoverable error a library caller would see, and print it.
  const error = new ProductionReadinessError(report);
  console.error(`\n${error.name}: ${error.message}`);
  console.error("\nRefusing to proceed. A production deploy that runs on a sandbox, simulator, mock, or");
  console.error("fallback-secret driver is the one class of accident with no clean rollback. Configure the");
  console.error("bindings named above and re-run; nothing here can be skipped.");
  process.exit(1);
}

console.log("\nAll blocking checks passed. Production configuration is on live, non-mock drivers.");
process.exit(0);
