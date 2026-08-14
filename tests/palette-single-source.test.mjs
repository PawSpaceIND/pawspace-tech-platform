import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

// ---------------------------------------------------------------------------
// One palette, defined once.
//
// app/globals.css declares the design tokens, and then 58 of the 65 module stylesheets write the same
// colours again as raw hex - 1526 times. That is why retoning the palette did not reach every screen,
// and why the two Team shells had drifted into two different reds, two different greens and four
// different greys for the same three roles:
//
//   danger border   #f6c8c4 (team-shell)  vs  #f5c2c0 (team-console)
//   success text    #14663c               vs  --ds-success-500 #11885b
//   muted text      #6c7c78, #5b6966, #6a7a76, #859692  vs  --ds-text-muted #697a76
//
// team-console.module.css even disagreed with itself inside one declaration: `var(--line, #dcece5)`,
// where --line is #d8e6e0 - the inline fallback was a stale copy of the variable it was falling back to.
//
// Converting all 58 files at once would restyle every screen in the product during UAT, so this is a
// burn-down, same shape as the lint baseline and the loop-shim ratchet. The count may fall, never rise:
// a new hardcoded token colour fails here, and each conversion lowers the number visibly in the diff.
// ---------------------------------------------------------------------------

/** Expand #abc to #aabbcc so the two spellings of one colour compare equal. */
const normalise = (hex) => {
  const value = hex.toLowerCase();
  return value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value;
};

test("no stylesheet adds a new hardcoded copy of a colour a token already defines", async () => {
  // 1526 hardcoded token colours across 58 module stylesheets. Lower this as files convert.
  const BASELINE = 1526;

  const globals = await readFile("app/globals.css", "utf8");
  const tokenByColour = new Map();
  for (const match of globals.matchAll(/(--ds-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6});/g)) {
    tokenByColour.set(normalise(match[2]), match[1]);
  }
  assert.ok(tokenByColour.size > 20, `expected the design tokens in globals.css, found ${tokenByColour.size}`);

  const files = [];
  for await (const entry of glob("app/**/*.module.css")) files.push(entry);
  assert.ok(files.length > 40, `expected many module stylesheets, found ${files.length}`);

  let found = 0;
  const worst = [];
  for (const file of files.sort()) {
    const source = await readFile(file, "utf8");
    const hits = [...source.matchAll(/#[0-9a-fA-F]{3,6}/g)].filter((m) => tokenByColour.has(normalise(m[0])));
    found += hits.length;
    if (hits.length) worst.push(`${String(hits.length).padStart(4)}  ${file}`);
  }

  assert.ok(
    found <= BASELINE,
    `hardcoded token colours rose from ${BASELINE} to ${found}. Use the var(--ds-*) token instead of the hex:\n${worst.slice(0, 5).join("\n")}`,
  );
  if (found < BASELINE) console.log(`  ${BASELINE - found} converted since the baseline; lower BASELINE to ${found} in this file.`);
  console.log(`  ${found} hardcoded token colours remain, heaviest first:\n${worst.sort((a, b) => Number(b.trim().split(/\s+/)[0]) - Number(a.trim().split(/\s+/)[0])).slice(0, 5).join("\n")}`);
});

test("the three converged stylesheets stay on the tokens", async () => {
  // The two Team shells and the performance page are done. Naming them means a regression in the files
  // this change actually converted fails loudly, rather than hiding inside a baseline of 1500.
  for (const file of [
    "app/components/ui/team-shell.module.css",
    "app/team/team-console.module.css",
    "app/team/performance/performance.module.css",
  ]) {
    const source = await readFile(file, "utf8");
    const hexes = [...source.matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => m[0]);
    assert.deepEqual(hexes, [], `${file} is converged and must use var(--ds-*) only, found ${hexes.join(", ")}`);
    // And the legacy aliases must not come back here: --purple holds the emerald ink, so a scope that
    // redefines it turns these surfaces literally purple.
    assert.doesNotMatch(source, /var\(--(purple|line|ink|muted|green|orange|cream)[,)]/, `${file} must use the --ds-* names, not the legacy aliases`);
  }
});
