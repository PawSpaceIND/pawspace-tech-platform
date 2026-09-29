# R05 — hosted Grooming selection test repair

Base reproduction: deployed c1a5bd5ef0447beb3911ff52b31b55cf0c114376.
Original hosted run: 36528294137; artifact: 11015517751.
Branch: fix/r05-hosted-groomer-selection-20260929.

## Cause and boundaries
The hosted runner selected the first provider-section button and expected a bold
provider name. That button now intentionally selects automatic matching and has
no named-card markup. The real preview returned three eligible UAT groomers,
reserved=false. The recorded trace has no canonical-booking or checkout request.
This is a test-runner defect, not proof of a customer-selection or finance defect.
The first hosted attempt exercised a synthetic customer/pet and pricing records.

## Repair
Both the hosted journey and rendered-page regressions use chooseFirstNamedGroomer.
It scopes the provider section, selects a named card, asserts pressed/check-mark
state, automatic-mode deselection and the exact Groomer summary. It does not reserve.
The positive case checks no writes at selection, then a normal specific-provider
reservation with exact provider identity, one booking and no payment order.
The existing unavailable-provider test retains its no-replacement/no-booking/no-
payment assertions. Payment, pricing, scheduling, permission and UI code are unchanged.

## Recovered local verification
After the workstation reconnected, the complete saved logs and exit files were read:
4/4 desktop/mobile rendered-page cases passed, zero retries; typecheck and focused
lint exited 0. These used synthetic API/payment doubles, not hosted transactions.
