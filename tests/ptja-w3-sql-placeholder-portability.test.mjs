/**
 * SQL placeholders must be positional. [PTJA-W3-CI]
 *
 * WHAT HAPPENED. lib/service-policy-governance.ts resolved a policy with numbered placeholders reused
 * across the statement - `service_code=?1 ... city_id=?2 ... policy_domain=?3 ... effective_from<=?4`
 * with ?1, ?2 and ?4 each appearing more than once, bound with four positional values. That is valid
 * SQLite and it passed every local run on Node 22.22. CI pins Node 22.13.0, whose node:sqlite handles
 * numbered parameters differently, and the same query raised "column index out of range" - taking 344
 * tests down with it, because the policy kernel sits under nine governed domains.
 *
 * The lesson is not "that query was wrong". It is that a query which only works on the Node the author
 * happens to run is not a working query, and nothing in the repository said so. This guard does.
 *
 * Repeating a bound value costs nothing and behaves identically on every version.
 *
 * The literals are found with a scanner rather than a regex. The first version of this guard used
 * /"[^"\n]{20,}"|`[^`]{20,}`/g and was worthless: a backtick inside a prose comment, or a template
 * shorter than the minimum length, desynchronises quote parity for the rest of the file, so what came
 * back was the gaps BETWEEN the strings. It reported zero offenders against a file that had them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

/** `?1`, `?12` … used as a bind parameter. Not matched: `x?1:0` ternaries, which need the `:`. */
export const NUMBERED_PARAM = /[=<>(\s,]\?[1-9][0-9]?(?![0-9:])/;

const SQL_START = /\b(SELECT|INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\b/i;

/**
 * The bodies of every string literal in a TypeScript source, skipping comments and regex literals so
 * that a quote or backtick in prose cannot shift the parity of everything after it.
 */
export function stringLiterals(source) {
  const out = [];
  const n = source.length;
  let i = 0;
  let prev = ""; // last significant character, to tell division from a regex literal
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") { i = source.indexOf("*/", i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === "/" && /^$|[(,=:[!&|?{};+\-*%~^]/.test(prev)) { // regex literal, not division
      i++;
      let cls = false;
      while (i < n) {
        const r = source[i];
        if (r === "\\") { i += 2; continue; }
        if (r === "[") cls = true;
        else if (r === "]") cls = false;
        else if (r === "/" && !cls) { i++; break; }
        else if (r === "\n") break;
        i++;
      }
      prev = "/";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      i++;
      let depth = 0; // ${ … } interpolation depth, so a nested string does not close the template
      while (i < n) {
        const s = source[i];
        if (s === "\\") { i += 2; continue; }
        if (c === "`" && depth === 0 && s === "$" && source[i + 1] === "{") { depth++; i += 2; continue; }
        if (c === "`" && depth > 0) {
          if (s === "{") depth++;
          else if (s === "}") depth--;
          else if (s === '"' || s === "'" || s === "`") { // a string inside the interpolation
            const q = s; i++;
            while (i < n && source[i] !== q) { if (source[i] === "\\") i++; i++; }
          }
          i++;
          continue;
        }
        if (s === c) { i++; break; }
        if (s === "\n" && c !== "`") break; // an unterminated quote is not a literal
        i++;
      }
      out.push(source.slice(start, i));
      prev = '"';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

async function sqlBearingSources() {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) { await walk(`${dir}/${entry.name}`); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      found.push([path, await readFile(new URL(`../${path}`, import.meta.url), "utf8")]);
    }
  };
  for (const root of ["lib", "app/api", "backend/src"]) await walk(root);
  return found;
}

function numberedPlaceholderOffenders(sources) {
  const offenders = [];
  for (const [path, source] of sources) {
    for (const literal of stringLiterals(source)) {
      if (!SQL_START.test(literal)) continue;
      if (NUMBERED_PARAM.test(literal)) {
        const at = literal.match(NUMBERED_PARAM);
        offenders.push(`${path}: ${literal.slice(Math.max(0, at.index - 60), at.index + 20).replace(/\s+/g, " ").trim()}`);
        break;
      }
    }
  }
  return offenders;
}

test("CI-01: no SQL statement binds a numbered placeholder", async () => {
  assert.deepEqual(numberedPlaceholderOffenders(await sqlBearingSources()), [],
    "use positional ? and repeat the bound value: node:sqlite's numbered-parameter handling differs across the Node versions this repository runs on, and CI pins an older one than most development containers");
});

test("CI-02: the guard finds the multi-line query the outage came from", async () => {
  // Non-vacuity, against the real shape and not a toy string. A guard that matches nothing would pass
  // CI-01 for ever, which is exactly what the first version of this file did.
  const source = [
    "/** A comment with a stray ` backtick and a 'quote', which must not shift parity. */",
    "const short = `${x}`;",
    "const q = db.prepare(",
    "  `SELECT *, CASE WHEN service_code=?1 AND city_id=?2 THEN 0",
    "   WHEN service_code=?1 AND city_id='*' THEN 1 ELSE 3 END rank",
    "     FROM service_policy_configs",
    "     WHERE policy_domain=?3 AND effective_from<=?4 AND (effective_to IS NULL OR effective_to>=?4)`)",
    "  .bind(a,b,c,d);",
  ].join("\n");
  assert.deepEqual(numberedPlaceholderOffenders([["fixture.ts", source]]).length, 1,
    "the multi-line template literal the outage came from is caught");

  const positional = source.replace(/\?[1-9]/g, "?");
  assert.deepEqual(numberedPlaceholderOffenders([["fixture.ts", positional]]), [],
    "and the positional rewrite of the same query is not");
});

test("CI-03: the scanner reads literals, not the gaps between them", async () => {
  // The defect that made the first version vacuous, named directly.
  const source = "/** prose with a ` backtick */\nconst a = `${x}`;\nconst sql = `SELECT * FROM t WHERE a=?1`;\n";
  assert.ok(stringLiterals(source).includes("`SELECT * FROM t WHERE a=?1`"),
    "the SQL template survives a stray backtick in a comment and a short interpolation before it");

  assert.equal(NUMBERED_PARAM.test("input.gstIncluded?1:0"), false, "a ternary reading ?1:0 is not a bind");
  assert.equal(NUMBERED_PARAM.test("WHERE a=? AND b=?"), false, "positional SQL is not a bind offence");
  assert.equal(NUMBERED_PARAM.test("WHERE a=?1"), true, "and a numbered bind is");
});
