import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("tracked application sources and test fixtures do not contain tool transport footers", () => {
  const paths = execFileSync("git", ["ls-files", "-z", "app", "lib", "worker", "backend", "tests/fixtures"], { encoding: "utf8" }).split("\0").filter(path => /\.(?:ts|tsx|mjs|json|jsonc|css)$/.test(path));
  assert.ok(paths.length > 100, "the real tracked tree must be scanned");
  const contaminated = paths.filter(path => /^\[executed on device:/m.test(readFileSync(path, "utf8")));
  assert.deepEqual(contaminated, [], "tool output is not application source or configuration");
});
test("all tracked JSON test manifests parse without trailing transport output", () => {
  const paths = execFileSync("git", ["ls-files", "-z", "tests/fixtures"], { encoding: "utf8" }).split("\0").filter(path => path.endsWith(".json"));
  assert.ok(paths.length > 5);
  for (const path of paths) assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")), path);
});
