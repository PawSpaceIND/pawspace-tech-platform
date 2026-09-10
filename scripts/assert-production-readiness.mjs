#!/usr/bin/env node
// Production readiness gate.
//
// ENFORCING (the profile resolves to "production", e.g. PAWSPACE_PRODUCTION_ENFORCE=true): every
// declared service must have its driver, production secrets, configuration and handlers in place.
// Production enforcement also permanently forbids test/UAT credential aliases and requires payments
// to remain sandbox-only with live approval explicitly disabled. A single gap exits non-zero.
//
// DRY RUN (any other profile): the guard cannot certify anything, so it returns the non-signable result
// and separately reports the gaps that would block enforcement. Only variable NAMES are ever printed.
import { appendFileSync } from "node:fs";
import {
  assertProductionReadiness,
  collectProductionReadinessProblems,
  isProductionProfile,
  deploymentProfile,
  ProductionConfigurationError,
  PRODUCTION_SERVICE_REGISTRY,
} from "../lib/production-readiness-enforcement.mjs";

const env = process.env;
const STRICT_DRY_RUN = String(env.PAWSPACE_READINESS_DRY_RUN_STRICT ?? "").trim() === "true";

function assertProductionCliInvariants() {
  if (!isProductionProfile(env)) return;
  const problems = [];
  if (String(env.PAWSPACE_TEST_API_POLICY_OVERRIDE ?? "").trim() !== "false") {
    problems.push("production: PAWSPACE_TEST_API_POLICY_OVERRIDE must be explicitly false");
  }
  if (
    String(env.PAWSPACE_PAYMENT_ENV ?? "").trim() !== "sandbox" ||
    String(env.PAWSPACE_PAYMENT_LIVE_APPROVED ?? "").trim() !== "false"
  ) {
    problems.push("production: payment environment must be locked to sandbox with live approval disabled");
  }
  if (problems.length) throw new ProductionConfigurationError(problems);
}

function dryRunGaps() {
  return collectProductionReadinessProblems(
    { ...env, PAWSPACE_PRODUCTION_ENFORCE: "true" },
    PRODUCTION_SERVICE_REGISTRY,
  );
}

function serviceOf(problem) {
  const [service] = String(problem).split(":");
  return service.trim() || "unknown";
}

function emitStepSummary(gaps, profile) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines = [
    "## Production readiness - DRY RUN (nothing was certified)",
    "",
    `Profile: \`${profile || "unspecified"}\` - enforcement: **off** - gaps: **${gaps.length}**`,
    "",
    gaps.length
      ? "These would block a run with `PAWSPACE_PRODUCTION_ENFORCE=true`. Names only - no values are read or printed."
      : "No gaps found. Enforcement would pass with this configuration.",
    "",
  ];
  if (gaps.length) {
    lines.push("| Service | Gap |", "| --- | --- |");
    for (const gap of gaps) {
      const service = serviceOf(gap);
      const detail = String(gap).slice(service.length + 1).trim();
      lines.push(`| \`${service}\` | ${detail} |`);
    }
    lines.push("");
  }
  try {
    appendFileSync(path, `${lines.join("\n")}\n`);
  } catch {
    // A summary is a convenience. Losing it must never change the gate's verdict.
  }
}

try {
  if (isProductionProfile(env)) {
    assertProductionCliInvariants();
    console.log(JSON.stringify(assertProductionReadiness(env)));
  } else {
    const profile = deploymentProfile(env);
    const result = assertProductionReadiness(env);
    const gaps = dryRunGaps();

    console.log(
      JSON.stringify({
        ...result,
        dryRun: true,
        readinessVerified: false,
        blocking: STRICT_DRY_RUN && gaps.length > 0,
        gapCount: gaps.length,
        gaps,
      }),
    );

    console.error(
      gaps.length
        ? `PRODUCTION_READINESS_DRY_RUN: NOT a production sign-off. ${gaps.length} configuration gap(s) would block enforcement.`
        : "PRODUCTION_READINESS_DRY_RUN: NOT a production sign-off. No configuration gaps detected.",
    );
    for (const gap of gaps) console.error(`::warning title=Production readiness gap::${gap}`);
    emitStepSummary(gaps, profile);

    if (STRICT_DRY_RUN && gaps.length) {
      console.error(
        "PAWSPACE_READINESS_DRY_RUN_STRICT=true: failing because the dry run found configuration gaps.",
      );
      process.exitCode = 1;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
