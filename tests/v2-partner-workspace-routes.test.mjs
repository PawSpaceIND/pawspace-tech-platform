import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const wrappers = {
  "boarding/page.tsx": "../../../host/page",
  "boarding/proof/page.tsx": "../../../../host/proof/page",
  "sitting/page.tsx": "../../../sitter/page",
  "sitting/proof/page.tsx": "../../../../sitter/proof/page",
  "walking/page.tsx": "../../../walker/page",
  "walking/proof/page.tsx": "../../../../walker/proof/page",
  "walking/recovery/page.tsx": "../../../../walker/recovery/page",
  "taxi/page.tsx": "../../../driver/page",
  "taxi/proof/page.tsx": "../../../../driver/proof/page",
  "taxi/recovery/page.tsx": "../../../../driver/recovery/page",
};

test("V2 partner workspace wrappers reuse canonical provider components", () => {
  for (const [relative, target] of Object.entries(wrappers)) {
    const source = fs.readFileSync(new URL(`../app/v2/partner/${relative}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(target.replaceAll("/", "\\/")));
  }
});

test("shared provider workspaces switch internal links by V2 pathname", () => {
  for (const file of [
    "../app/host/page.tsx", "../app/host/proof/page.tsx",
    "../app/sitter/sitting-workspace.tsx", "../app/sitter/proof/page.tsx",
    "../app/walker/page.tsx", "../app/walker/proof/page.tsx", "../app/walker/recovery/page.tsx",
    "../app/driver/canonical-driver-page.tsx", "../app/driver/proof/page.tsx", "../app/driver/recovery/page.tsx",
  ]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /usePathname/);
    assert.match(source, /\/v2\/partner\//);
  }
});
