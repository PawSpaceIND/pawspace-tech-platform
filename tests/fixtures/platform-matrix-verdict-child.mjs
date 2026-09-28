// Lightweight subprocess checks use actual parent-run evidence, not invented PASS rows.
import test from "node:test";
import { assertPlatformMatrix } from "../helpers/platform-matrix-verdict.mjs";
import { applyMatrixFault } from "../helpers/platform-matrix-faults.mjs";
const observed = JSON.parse(process.env.PAWSPACE_TEST_MATRIX_EVIDENCE || "");
assertPlatformMatrix(observed); // Setup must prove the untouched parent evidence first.
applyMatrixFault(observed, process.env.PAWSPACE_TEST_MATRIX_FAULT);
test("E2E-999 result matrix", () => assertPlatformMatrix(observed));
