// Faults mutate only a fresh test-evidence copy, never application state.
export const MATRIX_FAULTS = Object.freeze(["none", "settlement", "analytics", "GAP", "HARNESS", "UNKNOWN", "empty", "missing", "duplicate", "replacement"]);
export function applyMatrixFault(results, fault) {
  if (!MATRIX_FAULTS.includes(fault)) throw new Error("An explicit supported matrix gate test case is required");
  if (fault === "none") return;
  if (fault === "empty") { results.splice(0); return; }
  if (fault === "missing") { results.pop(); return; }
  if (fault === "duplicate") { results[results.length - 1] = { ...results[0] }; return; }
  if (fault === "replacement") { results[results.length - 1] = { module: "r01-unrelated", area: "replacement", status: "PASS", detail: "not a required probe" }; return; }
  if (fault === "settlement" || fault === "analytics") {
    const moduleName = fault === "settlement" ? "partner-settlement-governance" : "ai-analytics";
    const area = fault === "settlement" ? "statements from real earnings" : "build";
    const row = results.find((item) => item.module === moduleName && item.area === area);
    if (!row || row.status !== "PASS") throw new Error("Positive control did not execute successfully");
    row.status = "FAIL";
    row.detail = `R01 deliberate ${fault} gate fault`;
    return;
  }
  results.push({ module: "r01-deliberate-fault", area: "release-verdict", status: fault, detail: "test-only diagnostic" });
}
