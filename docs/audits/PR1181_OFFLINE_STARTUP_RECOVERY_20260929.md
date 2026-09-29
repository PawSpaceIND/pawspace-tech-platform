# PR #1181 — local Worker startup race, 29 September 2026

## Actual failure on fdf5a8cd
Run 36548092265, job 109340972213 (`Offline transport and storage`), recorded 79 passing cases and one failure out of 80. The scheduling-authorization test's Wrangler child exited before health with `Address already in use (127.0.0.1:34021)`. The final compatibility gate correctly failed because this required job failed. This is distinct from the earlier static-test quality failure, whose correction is retained.

The test reserved a temporary socket, closed it, and only then started Wrangler on that numeric port. The released port could be claimed during startup. A local test-only preloader deliberately claimed the socket immediately after the original probe closed it: the unchanged original test failed with the same bind error. This reproduction did not modify application or test sources and was not committed.

## Minimal correction
The scheduling test now launches the locked local Wrangler CLI directly, with explicit local mode, loopback address, HTTP port 0 and inspector port 0. Wrangler/OS owns the socket allocation instead of probing and releasing a candidate port. Readiness comes from that owned child's `DEV_SERVER_READY` IPC message and contains the actual bound port; output-log text and unrelated services are not treated as readiness.

The helper validates the loopback address and bound integer port, fails on startup error/exit/timeout, and releases event listeners and timers. Health reads are bounded. Missing child PIDs or already-signalled children do not trigger invalid shutdown calls. The existing isolated D1 persistence, all original permission and unchanged-database assertions, and the 120-second test limit remain intact.

Four added cases cover readiness ownership/listener cleanup, invalid address refusal, error/exit/timeout behavior, and concurrent real Workers while another listener remains active. The concurrency case checks distinct bound ports and executes the actual database authorization proof on both isolated Workers. The workflow now also triggers when this helper changes.

## Completed local verification
- Original deterministic race reproduction: 0/1 passed, expected bind failure.
- Corrected scheduling suite: 5/5 passed; three additional complete repeat runs also passed 5/5 each without retries or skipped assertions.
- Exact ten-file offline workflow selection: 84/84 passed, zero failures/cancellations/skips.
- Existing presentation, chat, payout, source-preservation, test-quality and CI-partition selection: 212/212 passed, zero failures/cancellations/skips.
- TypeScript, changed-source ESLint, diff whitespace check and all 21 pinned historical source checks passed.
- The original scheduling permission/database assertion block and Worker remain byte-identical. No app/, lib/, backend, payment, auth, CSS or original test-quality budget/detector change is part of this recovery.

Counts overlap and are not additive coverage totals. A separate attempt to extend this hardening to the sibling booking Worker was tool-blocked; its source remains unchanged and is not claimed as repaired. That existing test is included in the passing full offline selection.

Main remains ada600b6 at this checkpoint, including #1175, #1177, #1179 and #1174. The new exact-head CI must complete before merge; local evidence is not hosted acceptance. No deployment, live booking, approval, charge, payout or customer communication was submitted. The chat UI release and remaining audit findings are separate acceptance tasks.
