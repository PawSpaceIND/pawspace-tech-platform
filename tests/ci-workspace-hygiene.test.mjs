import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

test("Web Release CI resets tracked edits before cleaning untracked files",async()=>{
 const workflow=await readFile(new URL("../.github/workflows/closure-ci.yml",import.meta.url),"utf8");
 const web=workflow.slice(workflow.indexOf("  web-tests:"),workflow.indexOf("\n  lint:"));
 const resetAt=web.indexOf("git reset --hard HEAD"),cleanAt=web.indexOf("git clean -ffdx"),installAt=web.indexOf("npm ci");
 assert.ok(resetAt>=0,"Web CI must discard stale modifications to tracked files");
 assert.ok(cleanAt>resetAt,"untracked cleanup must run after the tracked-file reset");
 assert.ok(installAt>cleanAt,"workspace cleanup must finish before dependencies/tests run");
});
