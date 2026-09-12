# Happier Pets kit lock (2026-09-12)

Presentation-only overlay. Booking, Razorpay, RazorpayX, auth, and official logo files are unchanged.

## Tokens

- Emerald `#01261F`
- Gold `#E6B34E`
- Cream `#FFF8EE`

## Route mapping (logic stays)

| Board screen | Live route |
| --- | --- |
| Customer home | `/mobile-app`, `/` |
| Grooming | `/grooming` |
| Boarding | `/boarding` |
| Sitting / walking | existing sitting/walking routes |
| Taxi / relocation / funeral | existing pages; CTA remains coming-soon where APIs reject |
| Partner | `/partner-app` |
| Ops | `/admin`, `/control`, `/crm` |

## Tests that must stay green

- `Make PawSpace yours.` appearance dialog name
- `tests/customer-theme-system.test.mjs` emerald lock
