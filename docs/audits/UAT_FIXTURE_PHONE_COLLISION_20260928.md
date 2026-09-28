# UAT fixture phone collision — source recurrence guard

Date: 28 September 2026. Related operational blocker: #1166.
Base: `7f3a3bd63e9e8b1a0e5cf9e1ac0ae8bbcf380bd6`.

## Reproduced source gap
Both legacy WhatsApp certification provisioners compared raw digit strings. A local Indian number and its +91 representation therefore escaped that comparison, while the app's canonical recipient resolver correctly treats them as the same recipient. This reproduces a possible duplicate-creation path; it does not prove the historical event that created the current duplicate.
The v2 provisioner also excluded the existing fixture from its collision scan and overwrote its phone and consent on conflict, permitting a retired fixture to be reactivated.

## Change
- Both provisioners load the same pure guard and the application's canonical phone/key normalization.
- Inventory includes primary and secondary phones for ALL customers, including the fixture, with an independently returned count. Missing, failed or partial inventory refuses creation.
- The dedicated fixture must not already exist. Active, retired, or repurposed records are not automatically reused, reattached, or reset.
- Existing customer, preference, pet and booking records use `ON CONFLICT DO NOTHING`, not overwrite-on-replay.
- No recipient, raw inventory, credentials, or private account records are logged by the guard.

## Verification
- Node 22.16.0: 50/50 new tests passed; targeted guard + existing voice repair/policy regression selection: 112/112 passed, no skips.
- Node 24.19.0: 50/50 new tests passed.
- Both edited YAML files parsed successfully; `git diff --check` passed.
- No remote provisioning workflow, maintenance operation, dial, knowledge publication, or payment change was executed by this workstream.

## Remaining acceptance
This is preflight recurrence protection, not a database-wide unique-phone constraint or an atomic guarantee against all concurrent application writes. The existing dispatch-time ownership check stays unchanged. The independently authorized staging administrator must still retire only the founder-approved obsolete reference, verify unchanged history and exact ownership, and then perform the approved single handset demo. This PR alone cannot close #1166 or certify a successful call.
