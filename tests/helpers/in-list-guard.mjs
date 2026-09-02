/**
 * The guard that stops a module building an `IN (?,?,…)` list straight from a result set, which
 * breaks past D1's 100-bound-parameter cap.
 *
 * It lives here rather than inline in the suite so the same function that judges the real `lib/` can
 * be pointed at synthetic sources - a guard nobody can mutate-test is a guard nobody has checked.
 *
 * Two corrections after independent QA review of the first version:
 *
 *   1. It exempted any line containing the word `placeholders`. That is the name of the SAFE
 *      variable chunkedIn hands its callback, but it is also what anyone naming a raw build would
 *      call it - `const placeholders = ids.map(() => "?").join(",")` was accepted by the guard while
 *      being exactly the shape the guard exists to catch. Only an actual `chunkedIn` call now
 *      satisfies it.
 *   2. BOUNDED_IN_LISTS exempted whole FILES. One known-bounded list bought a module permanent
 *      immunity, so a new result-set-driven IN list added beside it was never seen - the same
 *      file-level blindness that let lib/company-analytics.ts carry three unchunked cost-ledger reads
 *      beneath a chunked payments read. The exemption is now the specific bounded expression.
 */

/** `.map(() => "?")` over a variable-length list is the shape that breaks past 100 rows. */
const RAW_PLACEHOLDER_BUILD = /\.map\(\s*\(\s*\)\s*=>\s*"\?"\s*\)/;

const squash = (value) => value.replace(/\s+/g, "");

/**
 * Bounded IN lists, allowlisted by the exact expression rather than by file. Each is a fixed
 * vocabulary - statuses, months, a single stay's pets - that cannot grow with the data.
 */
export const BOUNDED_IN_LISTS = {
  "boarding-ops-governance.ts": [{ expression: 'petIds.map(()=>"?")', why: "pet ids of a single stay" }],
  "haptik-outbound-audiences.ts": [{ expression: 'prerequisite.map(()=>"?")', why: "the 2-3 literal service codes a cross-sell campaign is built from, fixed at the call site" }],
  "lead-assignment-governance.ts": [{ expression: 'services.map(()=>"?")', why: "the service codes on one policy" }],
  "meet-and-greet.ts": [{ expression: 'rule.from.map(()=>"?")', why: "the literal statuses a transition may come from" }],
  "ops-work-queue.ts": [{ expression: 'allowedFrom.map(()=>"?")', why: "the literal statuses a task may be claimed from" }],
  "staff-alert-center.ts": [{ expression: 'check.types.map(()=>"?")', why: "the literal alert types the sweep owns" }],
  "statutory-compliance.ts": [{ expression: 'obligations.map(()=>"?")', why: "the obligations of one month" }],
  "subscription-wallet.ts": [{ expression: 'planCodes.map(()=>"?")', why: "the grooming plan catalogue" }],
  "tds-governance.ts": [
    { expression: 'fyMonths.map(()=>"?")', why: "the months of one financial year" },
    { expression: 'months.map(()=>"?")', why: "the months of one financial year" },
  ],
};

/**
 * Returns `file:line` for every call site that builds an IN list from a variable-length array without
 * going through chunkedIn. `bounded` is injectable so a test can prove the allowlist is call-site
 * specific rather than file-wide.
 */
export function findUnchunkedInLists(fileName, source, bounded = BOUNDED_IN_LISTS) {
  const allowed = (bounded[fileName] || []).map((entry) => squash(entry.expression));
  const offenders = [];
  source.split("\n").forEach((line, index) => {
    if (!RAW_PLACEHOLDER_BUILD.test(line)) return;
    // The ONLY thing that makes a built list safe: it is being fed a bounded chunk.
    if (line.includes("chunkedIn")) return;
    const flat = squash(line);
    if (allowed.some((expression) => flat.includes(expression))) return;
    offenders.push(`${fileName}:${index + 1}`);
  });
  return offenders;
}

/**
 * The guard exactly as it stood before this correction. Kept ONLY so the suite can demonstrate what
 * it used to accept - never used to judge the real tree.
 */
export function legacyFindUnchunkedInLists(fileName, source, bounded = BOUNDED_IN_LISTS) {
  if (fileName in bounded) return [];
  const offenders = [];
  source.split("\n").forEach((line, index) => {
    if (!RAW_PLACEHOLDER_BUILD.test(line)) return;
    if (line.includes("chunkedIn") || line.includes("placeholders")) return;
    offenders.push(`${fileName}:${index + 1}`);
  });
  return offenders;
}
