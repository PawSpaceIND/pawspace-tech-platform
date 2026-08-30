import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../lib/provider-capacity-governance.ts", import.meta.url), "utf8");

test("provider matching uses a statically bundled assignment gate in the Worker", () => {
  assert.match(source, /import\{assertProviderAssignable,filterAssignableProviders\}from"\.\/provider-assignment-eligibility"/);
  assert.doesNotMatch(source, /await import\("\.\/provider-assignment-eligibility"\)/);
});
