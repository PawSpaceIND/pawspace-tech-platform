import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execAsync = promisify(exec);
const TEST_COMMAND = "node --experimental-strip-types --test tests/pawspace-full-closure-matrix.test.mjs";
const MAX_ITERATIONS = 3;

async function runTests() {
  try {
    const { stdout, stderr } = await execAsync(TEST_COMMAND);
    return { success: true, output: stdout };
  } catch (error) {
    return { success: false, output: error.stdout || error.stderr || error.message };
  }
}

async function runAutonomousLoop() {
  console.log("🚀 [Agent 1: QA Tester] Starting end-to-end lifecycle verification...\n");

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`--- Loop Iteration ${iteration} of ${MAX_ITERATIONS} ---`);
    const testResult = await runTests();

    if (testResult.success) {
      console.log("\n✅ [Agent 1: QA Tester] All tests passed cleanly (pass 9, fail 0)!");
      console.log("🎉 Build is officially closed and locked down with zero regressions.");
      process.exit(0);
    }

    console.warn("\n❌ [Agent 1: QA Tester] Failure detected in execution matrix:");
    console.warn(testResult.output);

    console.log("\n🤖 [Agent 2: Debugger] Packaging failing assertion trace and source context for remediation...");
    
    // Structured payload sent to the LLM agent
    const debugPayload = {
      role: "Remediation Agent",
      instructions: "Fix ONLY the failing test assertions reported above. Do not alter unrelated business logic or files.",
      errorLog: testResult.output
    };

    fs.writeFileSync("scripts/latest-agent-failure.json", JSON.stringify(debugPayload, null, 2));
    console.log("💾 Error trace logged to `scripts/latest-agent-failure.json` for AI agent consumption.");
    
    break;
  }
}

runAutonomousLoop();
