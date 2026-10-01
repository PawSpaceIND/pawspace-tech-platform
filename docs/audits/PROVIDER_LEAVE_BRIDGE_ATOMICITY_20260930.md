# Provider leave bridge atomicity

The bridge introduced by main commit 7eedbfb could commit a leave decision before dispatch-block cleanup or recovery notification writes failed. Retrying the decision then found no pending request. It also deduplicated overlapping requests against another request's recovery case, so rejecting one request could remove the only recovery needed by the other.

This change prepares bridge writes and executes them in the same D1 batch as leave creation or the guarded leave decision, additive balance debit and decision audit. A failed bridge write leaves the original request pending, permitting a normal retry. Each request owns a distinct recovery case for an affected booking. Stable event/notification identities and snapshot assertions prevent duplicate or stale prepared recovery effects. Existing maker/checker, calendar, balance, provider eligibility and scheduling rules remain in place.

## Verification

- Native local workerd D1 negative controls fail independently for the original rejection-cleanup and overlapping-recovery defects; the creation rollback control also fails against the old bridge.
- Native D1 and transactional SQLite execute the same seven regression scenarios: creation rollback, independent overlapping recovery ownership, rejection cleanup rollback/retry, approval notification rollback/retry, single debit with retained reason, notification replay prevention, and refusal after an Operations recovery changes between read and commit.
- 193 focused tests pass, including existing financial/workforce native D1 profiles, people/partner tests and reviewed presentation source contracts.
- Typecheck, targeted ESLint and production Worker/artifact build pass locally.
- Nine source manifests update only the reviewed attendance-leave.ts hash.

All fixtures are synthetic. These checks perform no provider calls or live scheduling changes. Historical partial bridge records are not backfilled by this change; existing affected records require a separately reviewed reconciliation. Hosted checks must be evaluated on the published commit before merging.
