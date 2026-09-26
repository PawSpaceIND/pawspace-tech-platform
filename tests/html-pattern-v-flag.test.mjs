/**
 * QA (L6): Chrome compiles an input's pattern attribute with the RegExp `v` flag. "[0-9+\s-]" is a syntax error
 * there, so the enquiry phone check was silently skipped. Every pattern literal in app/ must compile with `v`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = new URL("../app/", import.meta.url).pathname;
function patterns(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) patterns(file, found);
    else if (file.endsWith(".tsx")) for (const match of fs.readFileSync(file, "utf8").matchAll(/pattern="([^"]*)"/g)) found.push({ file, pattern: match[1] });
  }
  return found;
}
test("every input pattern in the app compiles the way Chrome compiles it", () => {
  const all = patterns(root);
  assert.ok(all.length > 0);
  for (const { file, pattern } of all) assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, "v"), `${file}: ${pattern}`);
});
test("the enquiry phone pattern accepts Indian numbers and rejects letters", () => {
  const phone = new RegExp("^(?:[0-9+\\s\\-]{10,15})$", "v");
  assert.ok(phone.test("+91 98765-43210"));
  assert.ok(!phone.test("call me later"));
});
