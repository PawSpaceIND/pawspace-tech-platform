import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("Workers AI voice adapter sends authentication correctly", () => {
  const workersAi = read("lib/voice-workers-ai.ts");

  assert.match(workersAi, /Bearer \$\{accountId\}:\$\{apiToken\}/);
  assert.match(workersAi, /Authorization: `Bearer \$\{apiToken\}`/);
  assert.doesNotMatch(workersAi, /CF-Access-Client-Secret/);
});

test("Workers AI voice adapter delegates audio fetches through safeVoiceFetch", () => {
  const workersAi = read("lib/voice-workers-ai.ts");

  assert.match(workersAi, /import\s+\{\s*safeVoiceFetch\s*\}\s+from\s+"\.\/voice-safe-fetch\.ts"/);
  assert.match(workersAi, /await safeVoiceFetch\(source\)/);
});
