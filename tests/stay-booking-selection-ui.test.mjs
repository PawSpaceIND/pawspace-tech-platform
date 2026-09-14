import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("boarding and sitting selection controls and explicit care dates remain interactive", async () => {
  const {canPlanStay} = await import("../lib/stay-search-state.ts");
  assert.equal(canPlanStay({datesValid:true, petCount:1, serviceAvailable:true}), true);
  assert.equal(canPlanStay({datesValid:true, petCount:0, serviceAvailable:true}), false);
  const {stayCareWindow}=await import("../lib/stay-care-window.ts");
  const window = stayCareWindow("2026-09-20", "2026-09-20", "13:00", "17:00");
  assert.equal(window.scheduledEnd.getTime() - window.scheduledStart.getTime(), 4 * 60 * 60 * 1000);
  const flow = await read("app/mobile-app/stay-flow.tsx");
  assert.match(flow, /aria-pressed=\{mode === "boarding"\}/);
  assert.match(flow, /aria-pressed=\{mode === "sitting"\}/);
  assert.doesNotMatch(flow, /selectCareWindow/);
  assert.match(flow, /Check-in time<input type="time"/);
  assert.match(flow, /Check-out time<input type="time"/);
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
