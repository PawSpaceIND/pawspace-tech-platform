import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("boarding and sitting selection controls are explicit interactive buttons", async () => {
  const flow = await read("app/mobile-app/stay-flow.tsx");
  assert.match(flow, /aria-pressed=\{mode === "boarding"\}/);
  assert.match(flow, /aria-pressed=\{mode === "sitting"\}/);
  assert.match(flow, /aria-pressed=\{careWindow === window\}/);
  assert.match(flow, /onClick=\{\(\) => selectCareWindow\(window\)\}/);
  assert.match(flow, /aria-pressed=\{selectedPets\.includes\(p\.id\)\}/);
  assert.match(flow, /aria-pressed=\{selectedNeeds\.includes\(n\)\}/);
  assert.match(flow, /resetStaySelection\(\)/);
});

test("switching between Boarding and Pet Sitting remounts the correct service wizard", async () => {
  const mobile = await read("app/mobile-app/page.tsx");
  const entry = await read("app/mobile-app/stay-booking-page.tsx");
  assert.match(mobile, /key=\{`boarding:\$\{customer\.customerId\}`\}/);
  assert.match(mobile, /key=\{`sitting:\$\{customer\.customerId\}`\}/);
  assert.match(entry, /key=\{`\$\{selectedMode\}:\$\{account\.customerId\}`\}/);
  assert.match(entry, /mode=\{selectedMode\}/);
});
