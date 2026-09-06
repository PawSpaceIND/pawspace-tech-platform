import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// PTJA-P1-F36 — the same "absent drawn as present" screen, in three more verticals.
//
// /food/manage was fixed in PTJA-P1-F35. Sweeping for the shape that made it possible — a record
// rendered through String(value||"not set") with no not-found branch — found its three siblings, each
// with an `if(!bookingId)` guard and no loaded state at all. Rendered with an id that matches nothing:
//
//   taxi     "Manage trip PS-UAT-TAXI-NOPE · not set · trip not set"
//   walking  "Manage canonical walk schedule PS-UAT-WALK-NOPE · not set / Reserved walks /
//             Request cancellation ..." — a cancellation control for a booking that is not there
//   sitting  "PS-UAT-SIT-NOPE · loading / Care plan / Feeding / Medication / Emergency contact /
//             Vet / Home access / Save" — an EDITABLE form, with a Save button, for a booking that
//             does not exist. Sitting alone said "loading" in its header, and then rendered the whole
//             form underneath it anyway.
//
// WHAT THESE CASES DO AND DO NOT PROVE — measured, not assumed.
//
// react-dom/server runs no effects, so the state these render is `loading`, not `not-found`. Sabotage
// confirms it: collapsing not-found back into ready in lib/resource-screen-state.ts leaves every case
// in THIS file green and turns only P1-N01 (in the food suite) red. So these pin "nothing is drawn and
// nothing is clickable before the record has been loaded" — the browser-visible half, and the half
// that was actually broken — and they do NOT pin the not-found rendering of these three screens.
//
// The not-found half is covered instead by the shared decision's own cases (P1-N01..N03) plus browser
// verification of all three screens, recorded in ptja/phase1/P1-09. Stated here rather than left for a
// reader to assume, because a case that cannot fail is worse than no case at all.
// ---------------------------------------------------------------------------
installWorkersHooks("__MANAGE_NOT_FOUND_DB__");

async function renderText(path, props) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const mod = await import(path);
  return renderToStaticMarkup(React.createElement(mod.default, props)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
async function renderHtml(path, props) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const mod = await import(path);
  return renderToStaticMarkup(React.createElement(mod.default, props));
}

const SCREENS = [
  { name: "taxi", path: "../app/taxi/manage/taxi-customer-management.tsx", id: "PS-UAT-TAXI-NOPE", placeholder: /Manage Pet Taxi/ },
  { name: "walking", path: "../app/walking/manage/walking-customer-management.tsx", id: "PS-UAT-WALK-NOPE", placeholder: /Manage Dog Walking/ },
  { name: "sitting", path: "../app/sitting/manage/sitting-customer-booking.tsx", id: "PS-UAT-SIT-NOPE", placeholder: /Sitting/ },
];

test("P1-M01 no manage screen fabricates a record it has not loaded", async () => {
  for (const screen of SCREENS) {
    const text = await renderText(screen.path, { bookingId: screen.id });
    assert.ok(!/not set/.test(text),
      `${screen.name}: absent must not be drawn as an unset field: ${text.slice(0, 200)}`);
  }
});

test("P1-M02 no manage screen offers a control for a record it has not loaded", async () => {
  // The sharper half. A cancellation request, or a care plan with a Save button, must not be reachable
  // for a booking the screen has never seen.
  for (const screen of SCREENS) {
    const html = await renderHtml(screen.path, { bookingId: screen.id });
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    const enabled = buttons.filter((button) => !button.includes("disabled"));
    assert.equal(enabled.length, 0,
      `${screen.name}: ${enabled.length} enabled control(s) on an unloaded record: ${enabled.slice(0, 2).join(" ")}`);
  }
});

test("P1-M03 each screen still says something", async () => {
  // Non-vacuity for M01/M02: rendering an empty page would satisfy both.
  for (const screen of SCREENS) {
    const text = await renderText(screen.path, { bookingId: screen.id });
    assert.ok(text.length > 0, `${screen.name}: the screen must render something`);
    assert.match(text, /loading|could not|no longer|out of date|check the link/i,
      `${screen.name}: it must say what state it is in: ${text.slice(0, 160)}`);
  }
});

test("P1-M04 the no-id placeholder each screen already had is unchanged", async () => {
  // Non-vacuity: proves the id branch is genuinely being taken and the fix did not flatten the screens.
  for (const screen of SCREENS) {
    const text = await renderText(screen.path, { bookingId: "" });
    assert.match(text, screen.placeholder, `${screen.name}: its own empty-id screen still renders`);
  }
});
