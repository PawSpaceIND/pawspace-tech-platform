import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__V2_GROOMING_NAV_DB__", "__V2_GROOMING_NAV_ENV__");
const { GROOMING_STEPS, groomingStepAccess, suggestedGroomerId } = await import("../lib/v2/grooming-navigation.ts");
const ready = { petCount: 1, selectionIssue: false, hasPackage: true, packageIssue: false, addressVerified: true, reserving: false };
const unlocked = input => Object.entries(groomingStepAccess(input)).filter(([, reason]) => reason === null).map(([number]) => Number(number));
for (const [name, changes, expected] of [
  ["empty pet selection", { petCount: 0 }, [1]],
  ["mixed or otherwise invalid pets", { selectionIssue: true }, [1]],
  ["missing package", { hasPackage: false }, [1, 2]],
  ["ineligible package", { packageIssue: true }, [1, 2]],
  ["address still unverified", { addressVerified: false }, [1, 2, 3]],
  ["complete pre-reservation draft", {}, [1, 2, 3, 4]],
  ["reservation in flight", { reserving: true }, []],
]) test(`G10 blocks skipping required information: ${name}`, () => {
  const context = Object.freeze({ ...ready, ...changes });
  assert.deepEqual(unlocked(context), expected);
  assert.deepEqual(context, { ...ready, ...changes }, "navigation must not edit the draft");
});
test("G10 exposes exactly four uniquely addressed steps", () => {
  assert.deepEqual(GROOMING_STEPS.map(step => step.number), [1, 2, 3, 4]);
  assert.equal(new Set(GROOMING_STEPS.map(step => step.id)).size, 4);
});
const preview = providers => ({ providers, availabilityChecked: true, reserved: false, cityId: "blr", zoneId: "east", scheduledStart: "future", scheduledEnd: "future" });
test("G03 preselects the server's first eligible groomer without reordering by rating or name", () => {
  const providers = Object.freeze([Object.freeze({ id: "server-first", name: "Z", model: "commission", rating: 4 }), Object.freeze({ id: "other", name: "A", model: "full_time", rating: 5 })]);
  assert.equal(suggestedGroomerId(preview(providers)), "server-first");
  assert.equal(providers[0].id, "server-first");
});
test("G03 leaves checkout unselected when no groomer passed the server checks", () => {
  assert.equal(suggestedGroomerId(preview([])), "");
});
test("G03 never preselects from an unverified response", () => {
  assert.equal(suggestedGroomerId({ ...preview([{ id: "unverified" }]), availabilityChecked: false }), "");
});
test("G03 never confuses a reservation response with a read-only preview", () => {
  assert.equal(suggestedGroomerId({ ...preview([{ id: "held" }]), reserved: true }), "");
});
