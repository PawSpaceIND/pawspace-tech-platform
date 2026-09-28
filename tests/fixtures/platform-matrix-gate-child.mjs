// Integration control: execute the actual platform suite, then fault its terminal evidence.
import { beforeEach } from "node:test";
import { RESULTS } from "../e2e-platform-scale.test.mjs";
import { MATRIX_FAULTS, applyMatrixFault } from "../helpers/platform-matrix-faults.mjs";
const fault = process.env.PAWSPACE_TEST_MATRIX_FAULT;
if (!MATRIX_FAULTS.includes(fault)) throw new Error("An explicit supported matrix gate test case is required");
beforeEach((context) => {
  if (context.name === "E2E-999 result matrix") applyMatrixFault(RESULTS, fault);
});
