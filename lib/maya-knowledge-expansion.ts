// Scope expansion derived from Maya Master Knowledge Base v1.0 (26 Sep 2026).
// No live activation is performed by importing this module. All items use the existing review lifecycle.
import type {KnowledgeEntry} from "./maya-knowledge-base";
export const MAYA_KNOWLEDGE_EXPANSION:KnowledgeEntry[]=[
  {
    "sourceKey": "maya_policy_information",
    "title": "Policy questions are not action requests",
    "contentText": "A question about a refund, complaint, cancellation or reschedule process is an enquiry, not permission to perform it. Explain the approved process first. Do not create a refund, support case, booking change, payment link or human handoff just because a policy word occurs. Actual incidents, safety concerns, financial disputes and an explicit request for a person follow their governed handling."
  },
  {
    "sourceKey": "maya_refund_process",
    "title": "How refund review works; cancellation and groomer no-show enquiries",
    "contentText": "For a general refund question, explain that the team reviews the applicable purchased service terms, the booking and payment state, any service already delivered, and the reported cancellation or provider failure. Exact eligibility, amount, approval and timing require that review and the applicable policy. A request is not an approval, and approval is not a processed refund. Do not issue a refund, invent a fee or percentage, guarantee a bank deadline, or start a dispute from a hypothetical question."
  },
  {
    "sourceKey": "maya_complaint_process",
    "title": "How to raise a complaint and how the team follows it up",
    "contentText": "Explain the complaint process without assuming a hypothetical concern is an actual incident: identify the relevant booking, record a concise description in the customer's words, preserve relevant evidence through the approved channel, and submit the concern to the appropriate service team when the customer requests it. Give a case reference only after successful case creation. Report owner, progress, resolution and timing only from confirmed records. A real safety issue needs urgent handling; a request for a human must be honoured. Do not promise compensation or keep selling during an actual complaint."
  },
  {
    "sourceKey": "maya_reschedule_process",
    "title": "Reschedule cancellation and extension process questions",
    "contentText": "For an enquiry, explain that a change requires the existing booking, proposed date and time, service/pet scope, a new capacity check and applicable policy/price preview. Any revised amount must be explained before explicit customer confirmation. Until the system confirms the action, do not say the booking was changed or cancelled. Do not invalidate a pending offer merely because the customer asks how changes work. Purchased terms, not a generic new tariff, determine the policy."
  },
  {
    "sourceKey": "maya_tax_invoice",
    "title": "Are taxes included? GST amount and invoice explanations",
    "contentText": "Use the applicable live package tax-inclusive flag and the final quote or invoice breakdown. Do not add tax twice or assume every service uses the same treatment. A base catalogue amount is not necessarily the complete appointment total: only the quote can confirm included adjustments, add-ons, discounts and the amount due now. If the flag or breakdown is unavailable, state the exact missing information; do not expose partner commissions, infer tax from payouts, or invent a tax invoice."
  },
  {
    "sourceKey": "maya_payment_modes",
    "title": "Payment timing methods and channel permissions are separate",
    "contentText": "Payment timing and payment method are separate. Prepaid means payment before service; pay-after-service means later collection under the agreed terms. Cash or UPI acceptance does not choose the timing. Explain the founder-confirmed service rule and separately check whether the requested channel may execute it. Do not infer new AI voice permissions from business acceptance. Every payment must be recorded and reconciled against its booking; a customer claim, screenshot or payment-order creation is not verified receipt. Amount due now, later balance and verified paid amount remain distinct."
  },
  {
    "sourceKey": "maya_training_socialisation",
    "title": "Weekend socialisation and between-session support",
    "contentText": "Distinguish weekend scheduling from a separately offered centre socialisation visit. Check the purchased training plan for included socialisation sessions, centre, dates, admission rules, parent participation and transport. Do not promise free weekend visits for every programme. Between-session practice follows the trainer's guidance and the customer's agreed programme. Do not invent unlimited support, extra lessons, free transport or a fixed response time. Explain what is confirmed and request only the missing inclusion detail."
  },
  {
    "sourceKey": "maya_training_progress",
    "title": "Trainer replacement, completed lessons and remaining programme",
    "contentText": "Training appointments belong to one purchased programme with a finite session count and validity. Read completed, upcoming, cancelled and remaining sessions separately. A trainer replacement must preserve the dog's care notes and paid progress; do not restart consumption or promise a particular trainer is always available. A request to change a trainer is not a confirmed assignment. Unused-session refunds, extensions and makeup sessions follow the approved purchased terms."
  },
  {
    "sourceKey": "maya_grooming_extra_charges",
    "title": "Matted coat travel charges add-ons and extra time",
    "contentText": "Ask about coat condition, handling needs, selected pets and add-ons, and explain only the adjustments in the approved live quote. Severe knots or unusual handling needs may require professional assessment; do not promise free dematting, painless treatment or a universal surcharge. An add-on applies to its selected pet, not every pet automatically. Package, pet count and add-on changes require a fresh price and service window, with customer agreement before execution."
  },
  {
    "sourceKey": "maya_grooming_safe_handling",
    "title": "Nervous pets sedation force and grooming safety",
    "contentText": "Record known fears, bite or escape history, dryer sensitivity, prior distress and vet restrictions for the assigned professional. A paid package does not permit forced completion of unsafe procedures. Explain that handling and comfort must be assessed and the session may need breaks or to stop when unsafe. PawSpace AI must not offer sedation, prescribe medication or give veterinary clearance. A general question about safe handling is different from a pet who is currently injured or in distress."
  },
  {
    "sourceKey": "maya_boarding_care_plan",
    "title": "Boarding food routine medicines updates and handover",
    "contentText": "Collect the accepted feeding and sleeping routine, food supplied, behaviour and escape triggers, authorised vet instructions, and vet/emergency contacts through the permitted care-plan process. Food, litter, walks, pickup and exclusive care are included only if the accepted arrangement says so. A host's medication capability is not permission to change prescriptions or provide clinical treatment. Report actual care logs and updates; never invent photos, meals eaten or completed medicine."
  },
  {
    "sourceKey": "maya_boarding_time_units",
    "title": "Boarding daycare check-in checkout and billable units",
    "contentText": "Get exact check-in and checkout dates and times, location and pet count. Daycare and overnight stays are distinct care windows. Do not count calendar dates or assume a weekend means two billable days; the applicable tariff and returned quote determine the units. An early arrival, late collection or extension can affect both capacity and price, and requires the confirmed arrangement. Host homes and the PawSpace experience centre are not interchangeable."
  },
  {
    "sourceKey": "maya_centre_admission",
    "title": "Experience centre visits and admission rules",
    "contentText": "For centre enquiries, use the approved current location, contact, visiting/admission rules, opening hours and available package. Do not invent an address or promise an unscheduled visit. Centre-specific parent-entry rules must not be copied to every host home. A phone introduction, in-person introduction, daycare trial and paid stay are different options; a submitted request is not a confirmed appointment."
  },
  {
    "sourceKey": "maya_sitting_boundaries",
    "title": "Pet sitting duties overnight presence access and privacy",
    "contentText": "Agree the visit or overnight window and pet-care duties. Overnight does not automatically mean continuous awake supervision, unlimited walks, general housekeeping or clinical monitoring. Keep access/key and alarm details in the approved private handover channel. Use only authorised rooms; an unapproved visitor is not permitted by the booking. Report completed tasks from the care log. An extension or replacement needs availability, accepted scope, updated notes and customer communication."
  },
  {
    "sourceKey": "maya_walking_attendance",
    "title": "Walking calendar missed walks rain and substitute walker",
    "contentText": "Read the actual plan calendar rather than assuming a month contains a fixed number of visits. Separate scheduled, completed, missed, cancelled and remaining walks. Apply the purchased rule for customer changes, weather, access problems and provider absence. Do not mark a missed walk completed or grant a compensatory credit without authority. Keep the preferred walker as a preference; confirmed substitutions must carry current handling notes. Use timestamped actual tracking, not an imagined route."
  },
  {
    "sourceKey": "maya_taxi_quote",
    "title": "Pet taxi fare components airport return waiting parking handler",
    "contentText": "Collect actual pickup/drop, date/time, trip type, pets, passengers, luggage and whether a handler is requested. Obtain the appropriate vehicle/route quote, including approved waiting, airport, parking or other adjustments. Do not multiply a fare by pet count or double a one-way estimate to make a round trip. Cleaning or waiting charges must follow the accepted terms and required evidence, not an automatic AI surcharge. Vehicle fit, handler availability and dispatch require confirmation."
  },
  {
    "sourceKey": "maya_food_ingredients",
    "title": "Food ingredients allergens substitutions storage delivery",
    "contentText": "Use the current verified product label and ingredient record for allergens, portions, storage, expiry and dietary claims. Product names do not establish vegetarian or allergen-free status. Do not complete an allergen-sensitive order when the ingredient record is missing or conflicting. A substitute recipe requires explicit consent after checking ingredients. Clinical diet and treatment decisions belong to the veterinarian. Paid subscription status does not prove today's meal was delivered."
  },
  {
    "sourceKey": "maya_relocation_documents",
    "title": "Relocation route documents carrier acceptance and quarantine",
    "contentText": "Relocation is enquiry only: collect origin/destination, travel window, species, breed, size and documents already held, then route to the specialist team. Do not offer instant booking or collect payment. The specialist must verify current destination, carrier, transport and document requirements. Do not guarantee airline acceptance, no quarantine, approval or transit time from generic rules. Keep passport and sensitive identification out of ordinary chat."
  },
  {
    "sourceKey": "maya_funeral_arrangements",
    "title": "Funeral pickup farewell choices ashes and sensitive support",
    "contentText": "Begin with sympathy and ask only essential locality, pickup, timing and pet-size details. The specialist confirms the specific farewell options, transport, inclusions, private/shared arrangements, ashes and any chosen rites. Do not assume a religious service or add optional rites automatically. A starting price is not an all-inclusive quote. Stop unrelated sales and reminders. Uncertainty about whether a pet has died requires veterinary help, not an AI determination."
  },
  {
    "sourceKey": "maya_subscription_terms",
    "title": "Subscription credits family sharing expiry pause and renewal",
    "contentText": "Use the purchased plan for covered services/pets, credits per pet, reserved/used/available balance, expiry, eligible sharing and pause/grace/renewal terms. A session balance is not a money-wallet balance or PawPoints. Do not invent rollover, transferable ownership, free extension or automatic renewal. Compare the same covered package when discussing savings; do not quote a low per-session pack value as a one-time tariff."
  },
  {
    "sourceKey": "maya_account_privacy",
    "title": "Account identity saved address provider contacts and customer privacy",
    "contentText": "Verify account ownership before reading saved addresses, pets, payments, bookings or private care records. A typed phone number alone is insufficient. Share only permitted information for the current customer and role. Do not reveal partner private contact details, internal economic splits, staff salaries, secrets or another customer's records. Reuse a confirmed saved address but revalidate service coverage for the new request."
  },
  {
    "sourceKey": "maya_source_conflicts",
    "title": "Old advert price conflict and unavailable live information",
    "contentText": "Retain an offer or policy the customer relied on and request validation when it conflicts with current records. Do not pick the cheaper or newer-looking number, invalidate an existing purchase from a new tariff, or resurrect an expired offer. Explain supported facts and the exact detail awaiting confirmation. A missing tool result does not authorise a guessed price, provider, slot, payment status or completed action."
  },
  {
    "sourceKey": "maya_language_dates",
    "title": "Spoken amounts dates languages and corrections",
    "contentText": "Use the customer's requested language only when meaning and critical details can be preserved. Repeat confirmed dates in words with the year, and apply the booking's timezone. An ambiguous numeric date needs clarification. Keep service names, money, pet count and negation consistent across languages. A correction such as not Saturday but Sunday changes only the intended detail and must not create another booking or lose the earlier information."
  },
  {
    "sourceKey": "maya_partner_employee_scope",
    "title": "Partner employee and business enquiries versus customer service",
    "contentText": "Identify whether the caller is a pet parent, a prospective partner, an authenticated partner, an employee or a business contact. Explain public onboarding enquiries and route them to the relevant team. Private job, payout, payroll, incentive, identity and finance information requires role-specific authenticated access. The customer knowledge collection must not contain personal employee or partner records. A knowledge article is not permission to process documents, approve a payout or change staff data."
  },
{
  "sourceKey": "maya_grooming_payment_timing",
  "title": "Grooming prepaid pay-after-service cash and UPI",
  "contentText": "Grooming allows prepaid and pay-after-service. Cash and UPI are accepted. Timing and method are separate: cash does not automatically mean after-service, and UPI does not automatically mean upfront. Record and reconcile the payment against the booking; a customer claim or screenshot is not verified receipt. Business acceptance does not newly authorise AI voice to execute every option. Use the reviewed channel workflow and do not promise unsupported collection."
},
{
  "sourceKey": "maya_daycare_payment_timing",
  "title": "Daycare full prepaid or 50 percent split payment and 24 hour balance deadline",
  "contentText": "Daycare allows full prepaid or split payment: 50% at booking and the remaining 50% due 24 hours before the booking start date/time. Do not apply the overnight-stay longer-than-four-nights restriction to daycare. Calculate the deadline from the exact start timestamp and timezone, not just a calendar date. For bookings made less than 24 hours before start, the balance deadline has passed and founder clarification is required on whether full prepayment must be mandatory. Do not invent a later deadline or promise split eligibility for that short-notice case. This rule does not newly specify daycare payment methods or AI voice execution rights."
},
{
  "sourceKey": "maya_walking_payment_timing",
  "title": "Walking upfront-only payment one-time subscription renewal",
  "contentText": "Walking requires upfront payment only. One-time bookings, subscriptions and renewals are all prepaid. The former pay-after-service UAT assumption is superseded and must not be offered as an approved Walking rule. Payment method is a separate field in the applicable approved workflow; grooming cash/UPI acceptance does not automatically set Walking methods. Verify recorded and reconciled receipt, not a screenshot. Service calendar, holidays, weather cancellations and missed visits remain governed by the purchased plan and unresolved care-policy review."
},
{
  "sourceKey": "maya_food_payment_timing",
  "title": "Food prepaid-only payment and verified receipt",
  "contentText": "Food is prepaid only; do not offer pay-after-delivery or pay-after-service as an approved option. Payment timing does not validate ingredients, allergens, pack sizes, delivery availability, substitutions, expiry or recurring-plan terms. Verify those separately from approved product records. A customer claim or screenshot is not verified receipt, and a verified payment does not prove the food was delivered. No new AI voice collection permissions are granted by this business rule."
},
{
  "sourceKey": "maya_relocation_enquiry_only",
  "title": "Relocation enquiry only no instant booking or payment collection",
  "contentText": "Relocation is an enquiry-only service. Capture the customer's requirements and route them to the specialist team. Do not offer instant booking, collect a payment or generate a relocation payment link. Explain what details are needed without claiming the specialist has accepted, booked or dispatched anything unless verified. Public process guidance is not a universal route, document or quotation guarantee."
}
];
