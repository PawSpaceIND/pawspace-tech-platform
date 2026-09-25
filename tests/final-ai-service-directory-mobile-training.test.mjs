import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { listServiceControls, setServiceEnabled } from "../lib/service-control.ts";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("AI grounding receives the canonical enabled PawSpace service directory", async () => {
  const source = await read("lib/ai-grounded-runtime-provider.ts");
  assert.match(source, /context:\{\.\.\.input\.canonicalContext,approvedKnowledge:knowledge,catalogueTool,catalogue,serviceDirectory/);
  const { db } = freshCountingD1();
  const services = await listServiceControls(db);
  const byCode = new Map(services.map(service => [service.code, service]));
  for (const code of ["food", "relocation", "funeral_memorial", "vet_consult"]) assert.equal(byCode.get(code)?.enabled, true, code);
  await setServiceEnabled(db, { serviceCode: "relocation", enabled: false, reason: "Paused for UAT review", actorEmail: "ops@test" });
  const relocation = (await listServiceControls(db)).find(service => service.code === "relocation");
  assert.equal(relocation.enabled, false);
  assert.equal(relocation.disabledReason, "Paused for UAT review");
});

test("Training mobile checkout summary no longer overlays programme choices", async () => {
  const css = await read("app/training/canonical-training.module.css");
  assert.match(css, /@media\(max-width:720px\)\{\.shell\.shell \.stickyCard\{position:static!important\}\}/);
});
