import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("AI grounding receives the canonical enabled PawSpace service directory", async () => {
  const source = await read("lib/ai-grounded-runtime-provider.ts");
  assert.match(source, /listServiceControls/);
  assert.match(source, /serviceDirectory/);
  assert.match(source, /context:\{\.\.\.input\.canonicalContext,approvedKnowledge:knowledge,catalogueTool,catalogue,serviceDirectory/);
  const control = await read("lib/service-control.ts");
  for (const service of ["food", "relocation", "funeral_memorial", "vet_consult"]) assert.equal(control.includes(`code:\"${service}\"`), true, service);
});

test("Training mobile checkout summary no longer overlays programme choices", async () => {
  const css = await read("app/training/canonical-training.module.css");
  assert.match(css, /@media\(max-width:720px\)[^{]*\{[\s\S]*?\.stickyCard\{position:static;/);
});
