// Runner for the founder-approved stale UAT Training session cleanup on staging (26 Sep 2026). The logic,
// guards (staging host only, dry run unless DRY_RUN=false) and report live in
// lib/uat-staging-training-cleanup.mjs; this only runs it and sets the exit code.
import { redact, runCleanup } from "../lib/uat-staging-training-cleanup.mjs";

runCleanup().then(report => {
  if (!report.dryRun && (report.counts.failed > 0 || report.counts.remaining > 0)) process.exitCode = 1;
}).catch(error => {
  console.error(`Cleanup refused: ${redact(error instanceof Error ? error.message : "unexpected error", [String(process.env.PAWSPACE_UAT_ACCESS_CODE || "").trim()])}`);
  process.exitCode = 1;
});
