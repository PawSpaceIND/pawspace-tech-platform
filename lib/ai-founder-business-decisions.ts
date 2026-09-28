/** Founder-confirmed BUSINESS decisions, not runtime payment/voice permissions.
 * Imported only by the staff review/coverage layer. No activation, booking, collection or dial.
 */
export const AI_FOUNDER_BUSINESS_UPDATE={
  "id": "founder-business-2026-09-28",
  "date": "2026-09-28",
  "authority": "founder_confirmed_business_update",
  "publicationState": "reviewed_source_draft_not_activated",
  "supersedes": "conflicting assumptions in the previous audit for these six service rules only",
  "paymentTimingAndMethodAreSeparate": true,
  "receiptVerification": "booking-linked recorded and reconciled receipt; a customer claim or screenshot is not verification",
  "authorizations": {
    "liveKnowledgeActivation": false,
    "customerOrPaymentChanges": false,
    "handsetCall": false,
    "allVoicePaymentOptions": "not_newly_approved",
    "v2SourceAuthorityHierarchy": "not_newly_approved",
    "unresolvedCommercialTerms": "not_approved"
  }
} as const;

export const AI_FOUNDER_BUSINESS_DECISIONS=[
  {
    "id": "grooming_payment",
    "service": "grooming",
    "status": "founder_confirmed",
    "paymentTiming": [
      "prepaid",
      "pay_after_service"
    ],
    "paymentMethods": [
      "cash",
      "upi"
    ],
    "paymentMethodsAreExhaustive": false,
    "notes": "Timing and method are independent. No new voice-action entitlement is implied."
  },
  {
    "id": "grooming_subscription_payment",
    "service": "grooming_subscriptions",
    "status": "founder_confirmed",
    "paymentTiming": [
      "prepaid",
      "pay_after_service"
    ],
    "paymentMethods": [
      "cash",
      "upi"
    ],
    "paymentMethodsAreExhaustive": false,
    "collectionBasis": "clarification_required",
    "collectionMilestone": null,
    "creditActivationRule": null,
    "blockingQuestion": "grooming_subscription_collection",
    "notes": "Do not describe all subscriptions as prepaid-only or equate post-service collection with per-session collection."
  },
  {
    "id": "daycare_payment",
    "service": "daycare",
    "status": "founder_confirmed",
    "paymentTiming": [
      "prepaid",
      "split"
    ],
    "paymentMethods": null,
    "split": {
      "atBookingPercent": 50,
      "balancePercent": 50,
      "balanceDueHoursBeforeStart": 24,
      "overnightLongerThanFourNightsRestrictionApplies": false
    },
    "under24HoursRule": "clarification_required",
    "blockingQuestion": "daycare_under_24h",
    "notes": "Full prepaid or the specified split; no overnight-duration restriction. Payment methods were not newly specified for daycare."
  },
  {
    "id": "walking_payment",
    "service": "walking",
    "status": "founder_confirmed",
    "paymentTiming": [
      "prepaid"
    ],
    "paymentMethods": null,
    "appliesTo": [
      "one_time",
      "subscription",
      "renewal"
    ],
    "supersedes": "walking pay-after-service UAT assumption"
  },
  {
    "id": "food_payment",
    "service": "food",
    "status": "founder_confirmed",
    "paymentTiming": [
      "prepaid"
    ],
    "paymentMethods": null
  },
  {
    "id": "relocation_enquiry",
    "service": "relocation",
    "status": "founder_confirmed",
    "bookingMode": "enquiry_only",
    "instantBookingAllowed": false,
    "paymentCollectionAllowed": false,
    "workflow": "capture requirements and route to the specialist team"
  }
] as const;

// Read-only boundary preview for reviewers. The actual payment engines are unchanged.
const HOUR_MS=60*60*1000;
function explicitInstant(value:string){
 const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!parts)throw new Error('An explicit timestamp with timezone is required');
 const [year,month,day,hour,minute,second]=parts.slice(1).map(Number);
 if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)throw new Error('Invalid calendar timestamp');
 const parsed=Date.parse(value);if(!Number.isFinite(parsed))throw new Error('Invalid timestamp');return parsed;
}
export function previewDaycareSplitReview(input:{bookedAt:string;startsAt:string}){
 const booked=explicitInstant(input.bookedAt),starts=explicitInstant(input.startsAt);
 if(starts<=booked)throw new Error('Daycare must start after the proposed booking time');
 const balanceDue=starts-24*HOUR_MS,deadlinePassed=booked>balanceDue;
 return{reviewOnly:true as const,executionAuthorized:false as const,sourceId:AI_FOUNDER_BUSINESS_UPDATE.id,
  status:deadlinePassed?'founder_clarification_required' as const:'reviewed_split_terms' as const,
  atBookingPercent:50,balancePercent:50,balanceDueAt:new Date(balanceDue).toISOString(),
  fullPrepaidRequired:null,overnightDurationRestrictionApplies:false,
  unresolvedQuestion:deadlinePassed?'daycare_under_24h':null};
}
