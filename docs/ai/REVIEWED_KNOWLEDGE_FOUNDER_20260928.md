# Reviewed knowledge draft — founder business update, 28 September 2026

Source: founder-confirmed six-service update. **Draft for review; not activated.** These are the exact selected knowledge-card contents in this revision. They supersede only the specified conflicting audit assumptions. Existing purchased terms and unresolved decisions remain protected.

Payment receipt must be recorded and reconciled against the booking. Business permission and channel execution permission are separate. Handset stays on hold.

## Payment timing versus cash UPI methods and verified receipt

Source key: `maya_payment`

Payment timing and payment method are separate. Prepaid means payment before service; pay-after-service means later collection under the agreed terms. Cash or UPI acceptance does not choose the timing. Explain the founder-confirmed service rule and separately check whether the requested channel may execute it. Do not infer new AI voice permissions from business acceptance. Every payment must be recorded and reconciled against its booking; a customer claim, screenshot or payment-order creation is not verified receipt. Amount due now, later balance and verified paid amount remain distinct. Share only system-returned secure checkout links after the required confirmation. Never ask for an OTP, password, UPI PIN, CVV or full card/bank details.

## Payment timing methods and channel permissions are separate

Source key: `maya_payment_modes`

Payment timing and payment method are separate. Prepaid means payment before service; pay-after-service means later collection under the agreed terms. Cash or UPI acceptance does not choose the timing. Explain the founder-confirmed service rule and separately check whether the requested channel may execute it. Do not infer new AI voice permissions from business acceptance. Every payment must be recorded and reconciled against its booking; a customer claim, screenshot or payment-order creation is not verified receipt. Amount due now, later balance and verified paid amount remain distinct.

## Grooming prepaid pay-after-service cash and UPI

Source key: `maya_grooming_payment_timing`

Grooming allows prepaid and pay-after-service. Cash and UPI are accepted. Timing and method are separate: cash does not automatically mean after-service, and UPI does not automatically mean upfront. Record and reconcile the payment against the booking; a customer claim or screenshot is not verified receipt. Business acceptance does not newly authorise AI voice to execute every option. Use the reviewed channel workflow and do not promise unsupported collection.

## Grooming subscriptions: prepaid or pay-after-service, cash UPI and collection

Source key: `maya_grooming_subscriptions`

Grooming subscriptions allow prepaid or pay-after-service, and cash and UPI are accepted. Do not describe subscriptions as prepaid-only. The post-service collection basis is awaiting founder clarification: per redeemed session or the entire pack at a specified milestone. Do not invent that milestone, credit activation, redemption-before-payment or collection rules. Explain confirmed session count, package/pet coverage, validity and sharing from the purchased plan. A pack is not an automatic renewal mandate, and a per-session comparison is not a pay-as-you-go tariff. Verify actual credits and receipt records; payment timing or a screenshot does not establish active credits or verified payment. Sharing, pause/grace, expiry and cat-equivalent coverage remain subject to the final approved plan.

## Daycare full prepaid or 50 percent split payment and 24 hour balance deadline

Source key: `maya_daycare_payment_timing`

Daycare allows full prepaid or split payment: 50% at booking and the remaining 50% due 24 hours before the booking start date/time. Do not apply the overnight-stay longer-than-four-nights restriction to daycare. Calculate the deadline from the exact start timestamp and timezone, not just a calendar date. For bookings made less than 24 hours before start, the balance deadline has passed and founder clarification is required on whether full prepayment must be mandatory. Do not invent a later deadline or promise split eligibility for that short-notice case. This rule does not newly specify daycare payment methods or AI voice execution rights.

## Dog walking plans

Source key: `maya_walking`

Walking is upfront-payment only: one-time bookings, subscriptions and renewals are all prepaid. The pay-after-service UAT assumption is superseded. Dog walking gives scheduled outings of an agreed duration and frequency, such as one or two 30-minute walks a day, on weekly, monthly or quarterly plans. Prices come from the live plan and are confirmed for the service days and area. The parent keeps the leash or harness and waste bags ready and shares approved routes and handling notes. A harness is kinder for dogs that pull and for flat-faced breeds (Pug, Bulldog, Shih Tzu). Walking supports routine; behaviour problems need training, which can be offered separately. The preferred walker is subject to availability; substitutions are communicated. Missed or rained-out walks are checked against the plan's terms by the team.

## Walking upfront-only payment one-time subscription renewal

Source key: `maya_walking_payment_timing`

Walking requires upfront payment only. One-time bookings, subscriptions and renewals are all prepaid. The former pay-after-service UAT assumption is superseded and must not be offered as an approved Walking rule. Payment method is a separate field in the applicable approved workflow; grooming cash/UPI acceptance does not automatically set Walking methods. Verify recorded and reconciled receipt, not a screenshot. Service calendar, holidays, weather cancellations and missed visits remain governed by the purchased plan and unresolved care-policy review.

## Fresh pet food

Source key: `maya_fresh_food`

Food is prepaid only. This payment decision does not approve unresolved ingredients, labels, storage/expiry, delivery, substitution or recurring-plan terms. For fresh food, collect location, pet type and age, and the product or delivery need. The team confirms the current menu, pack sizes, ingredients, storage and delivery and pricing. The AI does not design medical diets or prescribe portions for illness; pets with allergies, kidney or other conditions should follow their vet. Switch foods gradually over about a week to avoid stomach upset.

## Food prepaid-only payment and verified receipt

Source key: `maya_food_payment_timing`

Food is prepaid only; do not offer pay-after-delivery or pay-after-service as an approved option. Payment timing does not validate ingredients, allergens, pack sizes, delivery availability, substitutions, expiry or recurring-plan terms. Verify those separately from approved product records. A customer claim or screenshot is not verified receipt, and a verified payment does not prove the food was delivered. No new AI voice collection permissions are granted by this business rule.

## Pet relocation between cities and abroad

Source key: `maya_relocation`

Relocation is enquiry only: capture requirements and route to the specialist team. Do not offer instant booking, collect payment or create a relocation payment link. Relocation is a specialist planning service handled by PawSpace's relocation team. Collect origin and destination cities, preferred travel date, pet type and count, breed and size, and whether it is domestic or international. Domestic moves usually need up-to-date vaccination records and a vet health certificate close to travel; international moves often also need a microchip, import permits and sometimes a rabies antibody test, which can take months. The team confirms the route, airline or road option, documents, crate size and price - the AI never gives legal entry requirements or fitness certification from memory. Snub-nosed breeds face airline restrictions.

## Relocation route documents carrier acceptance and quarantine

Source key: `maya_relocation_documents`

Relocation is enquiry only: collect origin/destination, travel window, species, breed, size and documents already held, then route to the specialist team. Do not offer instant booking or collect payment. The specialist must verify current destination, carrier, transport and document requirements. Do not guarantee airline acceptance, no quarantine, approval or transit time from generic rules. Keep passport and sensitive identification out of ordinary chat.

## Relocation enquiry only no instant booking or payment collection

Source key: `maya_relocation_enquiry_only`

Relocation is an enquiry-only service. Capture the customer's requirements and route them to the specialist team. Do not offer instant booking, collect a payment or generate a relocation payment link. Explain what details are needed without claiming the specialist has accepted, booked or dispatched anything unless verified. Public process guidance is not a universal route, document or quotation guarantee.

## Review boundary

This draft does not approve all voice payment options, a V2 source-precedence hierarchy, any unresolved commercial rule, live activation or customer/payment changes. The two open implementation questions and eight remaining commercial groups are in `FOUNDER_BUSINESS_DECISIONS_20260928.md`.
