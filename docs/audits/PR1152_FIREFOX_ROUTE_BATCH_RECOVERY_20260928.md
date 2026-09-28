# PR #1152: Firefox route-sweep timeout recovery

## Exact failure
At feature head `0d0fde5543a6d268948c04a6e976f3d9ce01b62c`, compatibility run `36391745588` passed offline checks, the desktop engine group, mobile device group and Chromium route/theme group. The Firefox/WebKit group failed because Firefox exhausted the existing 480,000 ms test deadline while looping over the full 129-route inventory. WebKit's corresponding sweep passed.

Failed job `108828909828` reported `Test timeout of 480000ms exceeded` at the existing 450 ms stabilization wait inside the route loop. Artifact `10957395599` includes 123 Firefox route screenshots and 129 WebKit screenshots. The trace shows cumulative successful page visits rather than the previously fixed coupon-panel radius assertion. Remaining unvisited/unasserted routes are not treated as passes.

## Repair
The same dynamically discovered, sorted routes and four existing appearance variants now run in groups of at most eight. Each group gets a fresh Playwright context and a 120-second test budget, replacing one ever-growing 480-second test. New routes automatically create more groups. An empty inventory fails registration instead of certifying no routes.

No route, browser engine, theme, selector, assertion or screenshot was removed. The visit helper, 15-second hydration check and 450 ms stabilization wait remain unchanged. Existing Firefox/WebKit project filters retain their original title prefixes and discover all applicable batches. Partial route evidence is attached in `finally`; failures still propagate.

The four job partitions, 30-minute job limits, one worker, zero retries, sandbox locks and aggregate compatibility gate are unchanged. Coupon, AI, payment and application source code are untouched.

## Evidence at publication
Four new scheduling/coverage regressions failed against the original source and pass with bounded batches. Together with the existing CI-partition/gate tests, **7/7** pass on the Mac. These registration tests execute the real specification with explicit page doubles; they are not browser-rendering evidence. Typecheck and changed-file lint pass. Playwright discovery lists **34 Firefox/WebKit batch cases**, covering the same 129 routes for each selected appearance.

Actual local Firefox/WebKit execution and current-head GitHub workflows are the remaining acceptance gates at publication. No successful current-head browser run, merge or deployment is claimed by this document. No production booking, payment or campaign change was made.
