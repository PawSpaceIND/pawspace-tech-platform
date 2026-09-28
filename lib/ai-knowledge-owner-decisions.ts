// These are unresolved review questions, NEVER customer-facing answer content.
export const AI_KNOWLEDGE_OWNER_DECISIONS=[
  {
    "id": "grooming_payment_modes",
    "owner": "Finance / founder",
    "question": "Which Grooming bookings may use pay-after-service or split payment, and what is due now versus after completion? Should the voice agent offer those modes or only explain them?",
    "affected": [
      "grooming",
      "payments"
    ]
  },
  {
    "id": "grooming_adjustments",
    "owner": "Commercial / Operations",
    "question": "Confirm the active tax-inclusive tariff and any permitted travel, coat-condition, access, early/late or add-on adjustments; identify which are quote-calculated and which require assessment.",
    "affected": [
      "grooming",
      "taxes"
    ]
  },
  {
    "id": "subscription_terms",
    "owner": "Commercial",
    "question": "Confirm currently sellable Grooming plan codes, package coverage, total/session count, validity, eligible pets, sharing, pause/grace, expiry and stacking. Historical totals and validity differ.",
    "affected": [
      "grooming",
      "subscriptions"
    ]
  },
  {
    "id": "training_socialisation",
    "owner": "Training Operations",
    "question": "Which training programmes include centre socialisation, how many visits, where and when, and are parent participation or transport included? Confirm multi-dog pricing and balance deadline.",
    "affected": [
      "dog_training"
    ]
  },
  {
    "id": "change_refund_policy",
    "owner": "Finance / service owner",
    "question": "Provide one approved policy by service for customer cancellation, reschedule, provider no-show, partially delivered service, refund review and communication of processing time. Preserve purchased terms.",
    "affected": [
      "all_services",
      "refunds"
    ]
  },
  {
    "id": "stay_and_walking_units",
    "owner": "Care Operations / Commercial",
    "question": "Confirm Boarding/Sitting/Daycare billable units and inclusions, extension rules, and Walking service days, holiday/weather/missed-visit treatment.",
    "affected": [
      "boarding",
      "sitting",
      "daycare",
      "walking"
    ]
  },
  {
    "id": "centre_support_contacts",
    "owner": "Operations",
    "question": "Confirm centre address and visiting/admission rules, service/support hours, the authorised public support contact and actual handoff owner/fallback. No fixed response time will be promised without approval.",
    "affected": [
      "all_services",
      "daycare",
      "support"
    ]
  },
  {
    "id": "food_product_labels",
    "owner": "Food Operations",
    "question": "Supply approved current ingredients/allergens, pack sizes, storage/expiry, delivery coverage, substitutions and recurring-plan terms. Conflicting public labels will not become AI facts.",
    "affected": [
      "food"
    ]
  },
  {
    "id": "taxi_relocation_funeral_scope",
    "owner": "Specialist Operations",
    "question": "Confirm active Taxi fare/handler/waiting inclusions and current specialist intake/routing for relocation and funeral; separate starting prices from confirmed all-inclusive quotes.",
    "affected": [
      "pet_taxi",
      "relocation",
      "funeral"
    ]
  }
] as const;
