// Root-level bridge so the repository's `tests/*.test.mjs` npm test glob executes
// the strict nested marketing contract without changing the shared test harness.
import "./marketing/gclid-export.test.mjs";
