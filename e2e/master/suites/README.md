Each `*.mjs` file here is one master-suite journey group, run by `e2e/master/run.mjs` in alphabetical order
after `preflight`. Journeys record product defects to `artifacts/master/findings.jsonl` and step results to
`artifacts/master/results.jsonl`; they exit non-zero only when the harness itself fails.
