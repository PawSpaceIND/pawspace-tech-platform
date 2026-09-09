# One build, one PawSpace UI — closure ledger

Internal staging only. Photo uploads and photo-dependent completion remain deferred. Existing access, payment and provider ownership controls must remain intact. Shared styling is not proof of module completion.

## Current work: grooming entry and review

- Preserve explicit puppy/kitten and species choices when saved pets load.
- Automatically select the first compatible saved pet, never a different species.
- Explain an already selected single pet without asking for a redundant selection tap.
- Show pet names, breeds and existing profile thumbnails in review; no new upload capability.
- Keep committed booking references in partial-failure recovery and do not display backend exception text.
- Local verification: typecheck passed; targeted regression tests and deployment build recorded in the task handoff. Hosted validation still required for these changes.

## Remaining closure sequence

| Area | Required evidence before closing |
| --- | --- |
| Grooming | Browser check of entry selection, multi-pet review, package/subscription prices, schedule rejection, sandbox payment and confirmation recovery |
| Training | DOB/age package eligibility, multi-pet selection, partial payment and subscription journey |
| Boarding / sitting | Separate services; governed duration choices and host/sitter availability; quote-to-booking parity |
| Walking / taxi / relocation / food | Route availability and launch restrictions, appropriate pet selection, price and booking recovery; verify memorial scope discrepancy rather than invent availability |
| Partner | Authenticated assigned-job lifecycle, GPS delays, offline/reconnect, earnings and permission states |
| Chat / inbox / voice | Authenticated chat, human handoff, delivery failures, microphone denied, disconnected voice, role-specific controls; no simulated success labelled live |
| CRM / control / employees | Role-specific entry, actual API actions, empty/error states, pricing controls and permission refusals |
| Unified visual redesign | Pet-first composition using existing imagery, three shared themes, clear body text, compact progressive detail, mobile/desktop and keyboard/200% checks on every journey |
| Handoff | Record Pass/Fail/Deferred per journey, integration dependencies and staging-only limitations; publish only the verified revision |

Do not describe the ecosystem as fully wired based on the home screen or aggregate test counts. A separate prototype is not the delivery target.
