// Owner-only review questions, never customer-facing answer content.
// Six settled business decisions are recorded separately; do not re-ask those as unresolved.
export const AI_KNOWLEDGE_OWNER_DECISIONS=[
  {
    "id": "daycare_under_24h",
    "category": "implementation_clarification",
    "owner": "Founder / Finance",
    "question": "For daycare booked less than 24 hours before start, must the booking be fully prepaid because the 50% split balance deadline has already passed? No rule is assumed until confirmed.",
    "affected": [
      "daycare",
      "payments"
    ]
  },
  {
    "id": "grooming_subscription_collection",
    "category": "implementation_clarification",
    "owner": "Founder / Finance",
    "question": "For grooming subscriptions paid after service, is collection per redeemed session or the entire pack amount at a specified milestone? Confirm that milestone and credit activation separately; neither is inferred.",
    "affected": [
      "grooming",
      "subscriptions",
      "payments"
    ]
  },
  {
    "id": "grooming_adjustments",
    "category": "commercial_policy",
    "owner": "Commercial / Operations",
    "question": "Confirm travel, access, early/late charges, de-matting assessment, and above-45-kg surcharge approval. Distinguish approved quote-calculated charges from assessment-dependent changes.",
    "affected": [
      "grooming",
      "taxes"
    ]
  },
  {
    "id": "subscription_terms",
    "category": "commercial_policy",
    "owner": "Commercial",
    "question": "Confirm final active plans, cat-equivalent package coverage, sharing, pause/grace and expiry. The confirmed prepaid/post-service choices do not settle these terms.",
    "affected": [
      "grooming",
      "subscriptions"
    ]
  },
  {
    "id": "training_socialisation",
    "category": "commercial_policy",
    "owner": "Training Operations",
    "question": "Confirm weekend centre socialisation eligibility, visit count, parent participation and transport. Existing code terms (50% upfront, balance scheduled for the final session, 60% extra per additional dog) remain unchanged; this question does not reopen or replace them.",
    "affected": [
      "dog_training"
    ]
  },
  {
    "id": "change_refund_policy",
    "category": "commercial_policy",
    "owner": "Finance / service owner",
    "question": "Resolve the conflicting full-refund and 100%/50%/0% policies, service exceptions, rescheduling fees and processing timelines. Do not choose a policy or apply it to existing purchases without the applicable approval.",
    "affected": [
      "all_services",
      "refunds"
    ]
  },
  {
    "id": "stay_and_walking_units",
    "category": "commercial_policy",
    "owner": "Care Operations / Commercial",
    "question": "Confirm holidays, weather cancellations, missed visits, extensions and included supplies. Walking upfront-only payment and daycare split timing are settled separately; overnight rules are not extended to daycare.",
    "affected": [
      "boarding",
      "sitting",
      "daycare",
      "walking"
    ]
  },
  {
    "id": "centre_support_contacts",
    "category": "commercial_policy",
    "owner": "Operations",
    "question": "Confirm operating address, hours, admission rules, handoff team and after-hours fallback; no response-time commitment is inferred.",
    "affected": [
      "all_services",
      "daycare",
      "support"
    ]
  },
  {
    "id": "food_product_labels",
    "category": "commercial_policy",
    "owner": "Food Operations",
    "question": "Supply verified labels/allergens, pack sizes, storage/expiry, delivery coverage, substitutions and recurring-plan terms. Food prepaid-only timing does not approve missing product facts.",
    "affected": [
      "food"
    ]
  },
  {
    "id": "taxi_funeral_scope",
    "category": "commercial_policy",
    "owner": "Specialist Operations",
    "question": "Taxi inclusions still need final confirmation. Funeral rates, pickup cutoff, overnight freezer and 50/50 Razorpay payment terms were approved by the owner on 1 October 2026 (maya-funeral-policy.ts). Staff must still confirm site availability, burial location, exact ash plantation kit, transport inclusions for burial/wooden cremation and any exception. Live funeral deposit-link execution remains an implementation gap. Relocation remains enquiry-only without instant booking or payment collection.",
    "affected": [
      "pet_taxi",
      "funeral"
    ]
  },
  {
    "id": "ai_voice_payment_access",
    "category": "separate_authorization",
    "owner": "Founder / Product / Finance",
    "question": "Which already-confirmed business payment options may the AI voice channel execute, and through which reviewed tools? This update does not newly approve voice access to every option. Preserve existing permissions.",
    "affected": [
      "voice",
      "payments"
    ]
  },
  {
    "id": "v2_source_authority_hierarchy",
    "category": "separate_authorization",
    "owner": "Founder / Commercial",
    "question": "Review the proposed V2 source-authority hierarchy separately. This update supersedes the specified conflicting audit assumptions only; it does not newly approve a global precedence rule or change purchased terms.",
    "affected": [
      "all_services",
      "source_authority"
    ]
  }
] as const;

export const AI_KNOWLEDGE_EXISTING_CODE_TERMS={
  "status": "existing_code_unchanged_not_new_approval",
  "dogTraining": {
    "upfrontPercent": 50,
    "balanceScheduledFor": "final_session",
    "extraPercentPerAdditionalDog": 60
  },
  "source": "Founder handoff 2026-09-28; existing training implementation retained",
  "notChangedByThisRevision": true
} as const;
