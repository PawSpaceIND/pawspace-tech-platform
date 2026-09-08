# Hosted performance evidence gate repair

The hosted Track 3 workload previously gated only aggregate p95. Its 10,000 ledger reads could hide the latency of 100 booking writes. It also wrote its artifact only after every request succeeded; an exception could leave no workload evidence, and Promise.all rejected before other launched requests finished recording their measurements.

The gate now applies its existing under-750 ms budget both to aggregate p95 and to every measured operation. It waits for all launched requests in a batch to settle before surfacing failures. Aborted runs write partial metrics, recorded failures, and `pipelineComplete:false`, and exit unsuccessfully. Successful execution still requires the original workload counts and zero recorded failures.

The workload now requires exact APP_ENV=staging and the sandbox financial triplet before its first request. The workflow declares these bindings and materializes both the gate and its helper from the workflow commit onto the pinned workload checkout.

Validation: 19 scale/gate tests passed. A synthetic transport test executes the real CLI, rejects one of 100 booking requests, lets the other requests finish, and verifies the failure artifact contains all 100 booking measurements. No network or provider service is used by that fixture. A distribution with 10,000 fast ledger reads and 100 slow bookings demonstrates that the aggregate check alone passes while the per-operation check correctly fails. Empty samples and the exact 750 ms boundary fail. Invalid or absent sandbox bindings are refused. JavaScript syntax, YAML parsing and diff checks passed.

This improves acceptance evidence; it does not establish actual hosted performance. No remote workload, deployment or provider transaction was dispatched. The workflow still pins its historical workload source, so its future results must be attributed to that revision unless the intended candidate is explicitly changed and deployed.
