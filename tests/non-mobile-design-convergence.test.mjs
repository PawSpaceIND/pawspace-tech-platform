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

test("canonical grooming board collapses below tablet so /partner has no horizontal overflow", () => {
  // The two-column work-order board carried fixed minmax minimums (300px + 420px + gap)
  // that exceeded the tablet content width and pushed a 19px horizontal overflow at 768px.
  // The board is now a responsive CSS-module grid that collapses to a single column at
  // tablet-and-below, keeping the desktop two-column layout above the breakpoint.
  const source = read("app/partner-app/canonical-grooming-jobs.tsx");
  assert.match(source, /canonical-grooming-jobs\.module\.css/, "board must use its responsive stylesheet");
  assert.match(source, /className=\{styles\.board\}/, "board grid must be class-driven, not a fixed inline grid");
  assert.doesNotMatch(source, /gridTemplateColumns:"minmax\(300px,\.9fr\) minmax\(420px,1\.1fr\)"/, "the overflowing fixed inline grid must be gone");
  const css = read("app/partner-app/canonical-grooming-jobs.module.css");
  assert.match(css, /\.board\s*\{[^}]*grid-template-columns:\s*minmax\(300px, ?\.9fr\) minmax\(420px, ?1\.1fr\)/, "desktop two-column layout is preserved");
  assert.match(css, /@media\s*\(max-width:\s*900px\)\s*\{[^}]*\.board\s*\{[^}]*grid-template-columns:\s*1fr/s, "board collapses to one column at tablet-and-below");
});
