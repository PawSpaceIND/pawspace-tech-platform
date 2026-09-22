/**
 * LP-D04 - "Live order impact" buttons broke words mid-word on a Pixel 7 (412px viewport): each of the
 * three buttons ("Package upgraded", "Service taking longer", "Running late") sat in a `flex:1` row with
 * no minimum width, and app/review-overrides.css's global phone baseline
 * (`main button{max-width:100%;white-space:normal;overflow-wrap:anywhere}`, higher specificity than the
 * component's own `.primaryActions button`) compressed each button to ~71px and then split individual
 * words across up to 5 lines ("Packa ge upgra ded").
 *
 * The fix gives just this button row (a new `.liveOrderActions` class, applied alongside the shared
 * `.primaryActions`) a real minimum width and reasserts word-boundary wrapping with !important, so it
 * cannot lose to the global rule regardless of stylesheet order. Whole words now fit; wrapping (which
 * must still happen at narrow widths) only ever breaks between words.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = () => readFile(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
const css = () => readFile(new URL("../app/partner-app/partner.module.css", import.meta.url), "utf8");

test("LP-D04: the Live order impact button row carries the dedicated liveOrderActions class", async () => {
  const source = await page();
  assert.match(source,
    /<div className=\{`\$\{styles\.primaryActions\} \$\{styles\.liveOrderActions\}`\}>\s*<button disabled=\{operationBusy\} onClick=\{\(\) => void reportOperation\("package_upgrade"\)\}>Package upgraded<\/button>/,
    "the three quick-action buttons must render inside the liveOrderActions row");
});

test("LP-D04: liveOrderActions gives each button a real minimum width and reasserts word-boundary wrapping", async () => {
  const stylesheet = await css();
  const rule = stylesheet.match(/\.liveOrderActions button\{([^}]*)\}/);
  assert.ok(rule, "the liveOrderActions button rule must exist");
  const body = rule[1];
  assert.match(body, /min-width:130px!important/, "a real minimum width, not the global main*{min-width:0} reset");
  assert.match(body, /overflow-wrap:normal!important/, "must not split words mid-letter to fit");
  assert.match(body, /word-break:normal!important/);
  // !important is required here because app/review-overrides.css's `.route-partner main button` /
  // `main button` rules carry HIGHER specificity (class + two elements) than a bare `.x button` module
  // rule (class + one element), so without it the global overflow-wrap:anywhere would still win.
  const overrides = await readFile(new URL("../app/review-overrides.css", import.meta.url), "utf8");
  assert.match(overrides, /main button,\s*main a \{ max-width: 100%; white-space: normal; overflow-wrap: anywhere; \}|main\s+button[^{]*\{[^}]*overflow-wrap:\s*anywhere/,
    "the global override this fix must out-rank is still in force for every other button");
});

test("LP-D04: at a Pixel 7 viewport, two liveOrderActions buttons at their new minimum width still fit the card without shrinking below it", async () => {
  const PIXEL_7_WIDTH = 412;
  const stylesheet = await css();
  const contentPadding = Number(stylesheet.match(/\.content\{padding:(\d+)px/)?.[1]);
  const noticePadding = Number(stylesheet.match(/\.notice[^{]*\{[^}]*padding:(\d+)px/)?.[1]);
  const gap = Number(stylesheet.match(/\.primaryActions\{[^}]*gap:(\d+)px/)?.[1]);
  const minWidth = Number(stylesheet.match(/\.liveOrderActions button\{flex:1 1 (\d+)px/)?.[1]);
  assert.ok([contentPadding, noticePadding, gap, minWidth].every(Number.isFinite), "all measurements must be read from the real stylesheet, not assumed");
  const available = PIXEL_7_WIDTH - 2 * contentPadding - 2 * noticePadding;
  assert.ok(available - gap >= minWidth * 2,
    `two buttons at ${minWidth}px plus a ${gap}px gap (${minWidth * 2 + gap}px) must fit the ${available}px card interior on a ${PIXEL_7_WIDTH}px phone, so the row wraps to a second line instead of compressing every button below its own minimum`);
});

test("LP-D04: the other two quick-action words also comfortably fit the new minimum width (whole-word wrap, not mid-word)", async () => {
  // A conservative per-character width bound for 13px/900-weight Inter - generous enough that if this
  // ever fails, the words genuinely would not fit and the defect could recur.
  const CHAR_WIDTH_PX = 9;
  const stylesheet = await css();
  const minWidth = Number(stylesheet.match(/\.liveOrderActions button\{flex:1 1 (\d+)px/)?.[1]);
  const buttonPadding = Number(stylesheet.match(/\.primaryActions button,\.notice button\{[^}]*padding:\d+px (\d+)px/)?.[1]);
  const availableTextWidth = minWidth - 2 * buttonPadding;
  for (const word of ["Package", "upgraded", "Service", "taking", "longer", "Running", "late"]) {
    assert.ok(word.length * CHAR_WIDTH_PX <= availableTextWidth,
      `"${word}" (${word.length} chars) must fit within ${availableTextWidth}px of text space so it never has to split mid-word`);
  }
});
