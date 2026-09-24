# PawSpace V2 browser-audit remediation - 24 September 2026

## Scope

This change addresses the founder-requested Chromium audit. It does not certify the entire application for human UAT. Login, OTP, privileged MFA, payment evidence, provider ownership and contact-consent gates remain unchanged.

The proposed synthetic staging persona feature was not completed and is not part of this change. No staging authentication or approval configuration is changed.

## Fixes

| Finding | Implementation | Proof |
| --- | --- | --- |
| BUG-ADDR-02: contradictory city/PIN accepted as a verified doorstep | Shared contradiction check in picker/server; distinguish area matching from map verification | Executable guard, real SQLite and browser rejection |
| BUG-ADDR-01: review hides street/apartment | Render complete service address including line 2 | Browser review and SQLite persistence assertions |
| BUG-PET-01: fifth pet has no promised enquiry | Focus a prefilled enquiry; retain four-pet booking; reuse idempotent public intake | Browser form-to-local-CRM; repeated intake produces one lead |
| BUG-CRM-01: manual lead selector omits Relocation | Add Relocation without changing canonical intake | Browser option and real contact/lead-work-item SQL assertions |
| Invalid phone reaches unvalidated lead create | Validate name/mobile before lead writes; add UI constraints | Actual CRM route refuses two-digit phone with 400 and no contact |
| Pending CRM request has no bounded outcome | Shared complete-response deadline, persistent ambiguous-save warning, duplicate-click lock | Real HTTP stalled-body and cancellation tests |

The address contradiction check is not a complete geocoder. Matching a PIN does not prove a doorstep exists. Server geocoding and service-area authority remain in force.

## External effects and authority

Guest customers still cannot confirm a booking. Associates still cannot call customers.manage routes: the negative test expects 403. No payment is declared captured, call placed, or WhatsApp consent automatically granted.

The browser tests are local-only; external Places suggestions alone are stubbed to exercise typed fallback. The enquiry uses the real isolated local CRM endpoint. Remote end-to-end certification remains a separate gate.
