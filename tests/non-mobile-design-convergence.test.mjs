import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("non-mobile workspaces use the shared convergence layer", () => {
  const files = [
    "app/crm/layout.tsx",
    "app/control/layout.tsx",
    "app/admin/layout.tsx",
    "app/partner/layout.tsx",
    "app/partner-app/layout.tsx",
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /workspace-convergence\.module\.css/, `${file} must use the shared non-mobile workspace theme`);
    assert.match(source, /convergence\.workspace/, `${file} must apply the shared workspace class`);
  }
});

test("shared convergence layer uses PawSpace emerald and gold tokens", () => {
  const css = read("app/components/ui/workspace-convergence.module.css");
  assert.match(css, /--ws-deep:\s*#01261f/i);
  assert.match(css, /--ws-gold:\s*#e6b34e/i);
  assert.match(css, /--ws-line:\s*#d8e6e0/i);
  assert.match(css, /\.crm\b/);
  assert.match(css, /\.control\b/);
  assert.match(css, /\.operations\b/);
  assert.match(css, /\.partner\b/);
});

test("canonical partner hub is no longer an inline-styled prototype", () => {
  const source = read("app/partner/page.tsx");
  assert.match(source, /partner-hub\.module\.css/);
  assert.doesNotMatch(source, /style=\{/);
  assert.match(source, /CanonicalGroomingJobs/);
});
