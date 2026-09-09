# PawSpace reference-led UX decisions

Reviewed 8 September 2026. References inform interaction patterns, not copied branding, claims, prices, imagery, or proprietary assets. Internal staging only.

## Evidence and application

- Rover: https://support.rover.com/hc/en-us/articles/203062280-How-do-I-find-a-sitter-or-dog-walker-for-my-pet — service, dates, pets, location filters and caregiver context. Apply pet-aware selection and clear requested-versus-confirmed states; preserve PawSpace's actual assignment rules.
- Mad Paws: https://www.madpaws.com.au/ — separates hosting at sitter's home from sitting at pet's home. Keep Boarding and Sitting distinct, describe where care happens, and show only substantiated trust attributes.
- Uber: https://help.uber.com/riders/article/yolculuk-talep-etme-?nodeId=e9862b49-81c6-4c6a-a9d3-3c05bf42e82e — GPS pickup with editing and accepted-driver ETA. Apply optional one-shot discovery location, editable doorstep details, and provider identity only after assignment/acceptance.
- Urban Company: https://www.urbancompany.com/ — city-aware services and upfront service scope. Apply concise inclusions, exclusions, time slots, and server-priced summaries.
- Pawfectly Made: https://pawfectlymade.com/ — current-location option, pet profiles, trial packs and meal plans. Apply trial/one-time/subscription comparison using PawSpace catalogue data, never competitor prices or nutrition claims.
- Swiggy's public page returned a JavaScript verification screen. Logo-while-locating is the user's reference, not an independently verified current screen.
- Kuddle and Snouters home pages yielded no inspectable content. Closure status and food offering were not independently verified. Do not invent findings.

## This increment

Welcome and Home use the same GPS-first picker. Neighbourhood/landmark search calls the existing public address lookup, resolves the selected place, then checks authoritative service-zone coverage. PIN entry is an optional collapsed fallback. All lookup states retain branded feedback and readable error text. Closing the picker unmounts it so late results cannot update the screen.

Discovery location is not a verified doorstep or final price. GPS permission remains explicit. Exact address is confirmed at checkout; no continuous tracking is introduced.

## Still pending — do not represent as implemented

- Guest package browsing and pet drafts with OTP only at final booking confirmation.
- Comparable grooming subscriptions, age-filtered outcome-based training packages.
- Genuine distance-based taxi pricing; current UAT route classes are not maps quotes.
- Food catalogue reconciliation, single-order versus subscription comparisons.
- Full service-specific booking, communications, partner and staff UI regression review.

Measure discovery-to-service, package-to-review, OTP completion, booking completion and explicit subscription choice. Do not use fake scarcity, unsupported savings, preselected paid upgrades, or competitor trust claims.
