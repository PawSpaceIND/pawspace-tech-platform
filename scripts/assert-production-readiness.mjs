#!/usr/bin/env node
// Production readiness gate.
//
// Two modes, and the difference between them is the whole point of this file.
//
// ENFORCING (the profile resolves to "production", e.g. PAWSPACE_PRODUCTION_ENFORCE=true): every
// declared service must have its driver, secrets, configuration and handlers in place. A single gap
// throws and this process exits non-zero. Unchanged from the original behaviour.
//
// DRY RUN (any other profile): the guard cannot certify anything, so it returns early. It used to
// print `{"ok":true,...,"releaseSignOffAllowed":false}` and exit 0, and nothing else. A workflow step
// whose only job was that call therefore went green while checking exactly nothing - it read as a
// production sign-off and was not one. The gaps that WOULD block enforcement are still knowable, so a
// dry run now computes and reports them instead of staying silent: the same evaluation is re-run with
// the production profile forced on, purely to produce the inventory. Nothing about the enforcing path
// changes, and the returned readiness payload is still the honest one.
//
// Only variable NAMES are ever printed. The evaluator reports missing names, never values, and
// tests/production-readiness-enforcement.test.mjs pins that a configured secret's value cannot appear
// in this output.
import { appendFileSync } from "node:fs";
import {
  assertProductionReadiness,
  collectProductionReadinessProblems,
  isProductionProfile,
  deploymentProfile,
  PRODUCTION_SERVICE_REGISTRY,
} from "../lib/production-readiness-enforcement.mjs";

const env = process.env;
const STRICT_DRY_RUN = String(env.PAWSPACE_READINESS_DRY_RUN_STRICT ?? "").trim() === "true";

// A dry run is not a production profile, so the evaluator would return no problems at all. Forcing
// the profile for THIS evaluation only is what makes the inventory available; the real assertion
// below still sees the unmodified environment and still reports that nothing was certified.
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
    "## Production readiness — DRY RUN (nothing was certified)",
    "",
    `Profile: \`${profile || "unspecified"}\` · enforcement: **off** · gaps: **${gaps.length}**`,
    "",
    gaps.length
      ? "These would block a run with `PAWSPACE_PRODUCTION_ENFORCE=true`. Names only — no values are read or printed."
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
    // Enforcing. assertProductionReadiness throws on any gap; the catch below exits non-zero.
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

    // Loud enough that nobody can mistake a green step for a sign-off.
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
