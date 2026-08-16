import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trainingPreviewCount, trainingSessionPreviewDates } from "../lib/training-session-preview.ts";

const flowSource = readFileSync(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8");

// Mirror of the weekdayMap the flow uses, so the test drives the same cadences the UI does.
const weekdayMap = {
  "Tue & Sat": [2, 6],
  "Wed & Sun": [3, 0],
  "Every Saturday": [6],
  "Choose each session myself": [0, 1, 2, 3, 4, 5, 6],
};
const start = new Date("2026-08-18T09:30:00Z"); // fixed, arbitrary start (session 1)

// ---------------------------------------------------------------------------
// The bug: an 8-session package previewed only 4 dates ("First four sessions"),
// which read as "only 4 booked". The preview must show the real package count.
// ---------------------------------------------------------------------------
test("an 8-session plan previews all 8 dates, not the old 4-date cap", () => {
  assert.equal(trainingPreviewCount(8), 8);
  const dates = trainingSessionPreviewDates(start, weekdayMap["Tue & Sat"], 15, trainingPreviewCount(8));
  assert.equal(dates.length, 8, "an 8-session plan must preview 8 dates");
});

test("12- and 16-session weekly cadences fill the full count (search window is wide enough)", () => {
  for (const count of [12, 16]) {
    const dates = trainingSessionPreviewDates(start, weekdayMap["Every Saturday"], 9, trainingPreviewCount(count));
    assert.equal(dates.length, count, `${count} weekly sessions must all preview (window must reach ~${count} weeks)`);
    // Consecutive same-weekday sessions stay exactly 7 days apart (skip index 1: the
    // first match after a possibly off-pattern start).
    for (let i = 2; i < dates.length; i++) {
      const gapDays = (dates[i].getTime() - dates[i - 1].getTime()) / 86_400_000;
      assert.equal(gapDays, 7, "a weekly cadence keeps a 7-day gap between sessions");
    }
  }
});

test("preview count falls back to 4 while the catalogue is still loading (plan.sessions=0)", () => {
  assert.equal(trainingPreviewCount(0), 4);
  const dates = trainingSessionPreviewDates(start, weekdayMap["Tue & Sat"], 15, trainingPreviewCount(0));
  assert.equal(dates.length, 4, "an unloaded plan previews the neutral 4-date sample");
});

// ---------------------------------------------------------------------------
// Guard: this is a display-only fix. The number of sessions actually booked must
// still come from the server quote, NOT the preview length.
// ---------------------------------------------------------------------------
test("the programme reservation still books quote.sessions occurrences — unchanged by the preview fix", () => {
  assert.match(
    flowSource,
    /occurrences:quote\.sessions,weekdays:weekdayMap\[frequency\]/,
    "the full-programme reserve must still use the server quote's session count",
  );
});

test("the misleading hard-capped label is gone and the preview is driven by the real session count", () => {
  assert.doesNotMatch(flowSource, /First four sessions/, "the 'First four sessions' label must be removed");
  assert.match(flowSource, /trainingSessionPreviewDates\(/, "the preview uses the shared generator");
  assert.match(flowSource, /trainingPreviewCount\(plan\.sessions\)/, "the preview count derives from plan.sessions");
  assert.match(flowSource, /Full session calendar/, "the label honestly reflects the full session calendar");
});
