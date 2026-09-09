# Compact cartoon UI — 8 September 2026

Direction: option 4's focused layout with small, expressive human-and-pet cartoon artwork. Not a new booking implementation.

## Delivered source scope

- All eight existing customer-home service cards use standalone 96px cartoon thumbnails and labelled full-card actions. Responsive two/three/four-column layout.
- Guest greeting uses a small decorative cartoon, not photographic marketing art. Saved pet photos remain actual customer data.
- Shared compact service headers use a 96px illustration beside service details, bringing package choices higher on the page.
- Expanded service banners use the same art; photographic example selectors are suppressed for these illustrated services. Actual configured service videos retain visibility, error and reduced-motion guards.
- System sans typography replaces the rounded global font. Three existing colour themes remain token-driven; illustrations retain brand-purple clothing in all themes.
- No pricing, authentication, payment, assignment, permission or API changes. No new service availability. No production deployment.

## Asset provenance

Generated with the built-in image tool: eight calls, no retries. Exact prompts: [cartoon-art-prompts.json](cartoon-art-prompts.json).

Original PNGs: workspace `output/cartoon-art/{grooming,training,walking,boarding,sitting,taxi,relocation,food}.png`.

App assets: `public/assets/pawspace-{grooming,training,walking,boarding,sitting,taxi,relocation,food}-cartoon.webp` (512px, quality 82; approximately 232 KiB total). Displayed with contain sizing to avoid cropping characters. These are fictional service illustrations, not provider identities, actual meals, customer pets or safety certifications.

Taxi depicts a harnessed dog in the rear, separated from the driver. Walking shows separate leads and harnesses. Boarding and Sitting have distinct multi-pet home settings. Relocation shows separate crates; this is not a crate-sizing guide.

## Validation boundaries

Build and 31 focused UI/source-contract tests passed. Typecheck run separately. This release does not claim full authenticated end-to-end booking QA, a complete partner/CRM redesign, or completion of Memorial and every requested breed variant. Photo-upload work remains deferred.
