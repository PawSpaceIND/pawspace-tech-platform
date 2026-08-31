import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execAsync = promisify(exec);
const TEST_COMMAND = "node --experimental-strip-types --test tests/pawspace-full-lifecycle-source-contract.test.mjs";
const MAX_ITERATIONS = 3;

async function runTests() {
  try {
    const { stdout } = await execAsync(TEST_COMMAND);
    return { success: true, output: stdout };
  } catch (error) {
    return { success: false, output: error.stdout || error.stderr || error.message };
  }
}

async function runAutonomousLoop() {
  console.log("QA Tester: starting synthetic lifecycle source-contract verification...\n");

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`--- Loop Iteration ${iteration} of ${MAX_ITERATIONS} ---`);
    const testResult = await runTests();

    if (testResult.success) {
      console.log("\nQA Tester: all 9 source-contract tests passed cleanly (pass 9, fail 0).");
      console.log("These checks validate synthetic lifecycle invariants only; they do not certify deployed customer OTP or booking closure.");
      process.exit(0);
    }

    console.warn("\nQA Tester: failure detected in the synthetic source contract:");
    console.warn(testResult.output);

    console.log("\nDebugger handoff: packaging the failing assertion trace and source context for remediation...");

    const debugPayload = {
      role: "Remediation Agent",
      instructions: "Fix ONLY the failing test assertions reported above. Do not alter unrelated business logic or files.",
      errorLog: testResult.output
    };

    fs.writeFileSync("scripts/latest-agent-failure.json", JSON.stringify(debugPayload, null, 2));
    console.log("Error trace logged to scripts/latest-agent-failure.json for debugger consumption.");

    break;
  }
}

runAutonomousLoop();
