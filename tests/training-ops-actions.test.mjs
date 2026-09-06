import test from "node:test";
import assert from "node:assert/strict";
import { trainingOpsActionsForStatus } from "../lib/training-ops-actions.ts";

test("terminal Training sessions expose no impossible Operations actions", () => {
  for (const status of ["completed", "cancelled", "no_show"]) {
    assert.deepEqual(trainingOpsActionsForStatus(status), {
      reschedule: false,
      replaceTrainer: false,
      noShow: false,
      cancel: false,
    });
  }
});

test("active Training controls mirror the server lifecycle", () => {
  assert.deepEqual(trainingOpsActionsForStatus("scheduled"), {
    reschedule: true,
    replaceTrainer: true,
    noShow: true,
    cancel: true,
  });
  assert.deepEqual(trainingOpsActionsForStatus("on_the_way"), {
    reschedule: false,
    replaceTrainer: false,
    noShow: true,
    cancel: false,
  });
});
