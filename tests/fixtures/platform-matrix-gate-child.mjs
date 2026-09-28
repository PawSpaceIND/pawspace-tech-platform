// Deliberate fault injection in this LOCAL TEST PROCESS only; never application code.
import { beforeEach } from "node:test";
import { RESULTS } from "../e2e-platform-scale.test.mjs";
const fault = process.env.PAWSPACE_TEST_MATRIX_FAULT;
const allowed = new Set(["none", "settlement", "analytics", "GAP", "HARNESS", "UNKNOWN", "empty", "missing", "duplicate"]);
if (!allowed.has(fault)) throw new Error("An explicit supported matrix gate test case is required");
beforeEach((context) => {
  if (context.name !== "E2E-999 result matrix" || fault === "none") return;
  if (fault === "empty") { RESULTS.splice(0); return; }
  if (fault === "missing") { RESULTS.pop(); return; }
  if (fault === "duplicate") { RESULTS[RESULTS.length - 1] = { ...RESULTS[0] }; return; }
  if (fault === "settlement" || fault === "analytics") {
    const moduleName = fault === "settlement" ? "partner-settlement-governance" : "ai-analytics";
    const area = fault === "settlement" ? "statements from real earnings" : "build";
    const row = RESULTS.find((item) => item.module === moduleName && item.area === area);
    if (!row || row.status !== "PASS") throw new Error("Positive control did not execute successfully");
    row.status = "FAIL";
    row.detail = `R01 deliberate ${fault} gate fault`;
    return;
  }
  RESULTS.push({ module: "r01-deliberate-fault", area: "release-verdict", status: fault, detail: "test-only diagnostic" });
});
