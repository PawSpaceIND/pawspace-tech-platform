import {detailFixtures, boardingQueue} from "./ui-audit-detail-fixtures";
// Synthetic, browser-only display fixtures. These never create business records.
const at = Date.UTC(2026, 8, 28, 10);
const reference = "UI-AUDIT-BOOKING-LONG-REFERENCE-20260928-0001";
export const canonicalTableRoutes = [
  "/team/customer-reminders", "/team/meet-and-greet", "/team/finance",
  "/team/voice", "/team/whatsapp/templates", "/team/lifecycle-reminders",
  "/team/subscription-plans", "/team/finance/reconciliation", "/team/finance/statutory",
] as const;
export const tableRoutes = canonicalTableRoutes.map(route=>"/v2"+route);
const fixtures: Record<string, unknown> = {
  "/api/customer-reminders": {
    policy: { groomingRebookingDays:15, subscriptionInactivityDays:10, subscriptionRenewalDays:7, isDefault:false },
    recentEvents: [{id:"UI-EVENT-1",customer_id:reference,reminder_type:"subscription_sessions",cycle_key:"ui",message_id:reference,duplicate_prevented:0,created_at:at}],
    outcomeTotals: [{reminder_type:"subscription_sessions",queued:1,suppressed:0,last_at:at}],
  },
  "/api/meet-and-greet": [{id:"UI-MEET-1",customerId:reference,hostProviderId:"UI-HOST-1",format:"house_visit",intendedStayStart:"2026-10-05",intendedStayEnd:"2026-10-08",intendedStayDays:3,preferredAt:at,priceCharged:499,priceWaivedReason:null,status:"requested",notes:null,bookingId:reference,createdAt:at}],
  "/api/whatsapp/templates": {templates:[
    {template_key:"ui_audit_booking_followup_long_name",display_name:"Booking follow-up",status:"approved",category:"utility",approved_language:"en",body:"Your appointment details",meta_reconciliation_status:"not_submitted",updated_by:"ui-audit",updated_at:at,sampleValues:[],usage:{sends:0,delivered:0,replies:0,bookings:0}},
  ],events:[],productionDelivery:false,externalMetaMutation:false,environment:"uat"},
  "/api/lifecycle-reminders": {rules:[{id:"UI-RULE-1",segment:"existing_customer",service_code:"grooming",trigger_code:"completed_service_rebook",delay_days:15,repeat_days:15,template_key:"ui_audit_reminder",active:1,configuration_required:0,notes:"Synthetic display record"}],active:1,configurationRequired:0,deliveryBoundary:"sandbox"},
  "/api/subscription-plans": [{id:"UI-PLAN-1",serviceCode:"dog_training",planCode:"ui-audit-training",cityId:"blr",name:"Obedience Programme — eight sessions",price:15992,sessionCount:8,validityValue:4,validityUnit:"months",active:true}],
};
const ledger = {
  services:[{code:"grooming",label:"Grooming",workspace:null,bookings:1,paidBookings:1,captured:123456.78,refunded:0,attention:0}],
  items:[{bookingId:reference,serviceCode:"grooming",packageName:"Complete Makeover",bookingStatus:"confirmed",scheduledStart:"2026-10-05T04:30:00Z",bookingTotal:123456.78,paymentId:"UI-PAY-1",paymentStatus:"captured",paymentMode:"prepaid",amountDueNow:123456.78,scheduleStatus:"paid",balanceAmount:0,capturedAmount:123456.78,refundedAmount:0,netCollected:123456.78,gatewayStatus:"captured",reconciliationStatus:"matched",varianceAmount:0,openExceptions:0,invoiceNumber:"UI/2026/0001"}],openExceptions:0,limit:150,
};
const overview = {
  generatedAt:at, summary:{openExceptions:1,criticalExceptions:1,overCollected:0,refundOverage:0,needsAttention:1,stuckWebhooks:1,uncountedCaptures:1,pendingCaptureEffects:0},
  exceptions:[{id:"UI-EXCEPTION-1",bookingId:reference,paymentId:"UI-PAY-1",eventId:"UI-EVENT-1",type:"unmatched_gateway_capture",severity:"critical",status:"open",detail:{amount:123456.78},createdAt:at,resolvedAt:null,resolvedBy:null}], records:[],
  stuckCaptures:{webhooks:[{id:"UI-WEBHOOK-1",eventId:"UI-EVENT-1",eventType:"payment.captured",environment:"sandbox",status:"PROCESSING",failureReason:"Synthetic display example",receivedAt:at,gatewayOrderId:reference,gatewayPaymentId:"UI-PAY-1",amount:123456.78,claimedBookingId:reference,captureRecorded:false}],effects:[]},
};
const readiness = {
  gate:{mode:"uat",enabled:false,blockedReason:"UI display fixture",uatApproved:false,liveApproved:false,telephonyCredentialsConfigured:false,statusCallbackConfigured:false,missingSecretNames:[],allowlistSize:0,recordingApproved:false,salesOutboundApproved:false,truth:{}},
  transport:{provider:"local_simulator_non_production",configured:false,mode:"uat"},useCases:[],scripts:[],productionCallsPlaced:0,unappliedProviderEvents:0,callsOpenOverAnHour:0,
};
const calls = [{callId:reference,state:"blocked_disabled",useCase:"service_recovery",purpose:"service_recovery",provider:"local_simulator_non_production",providerCallId:null,productionCall:false,mode:"uat",consentDecision:"not_evaluated",optOutDecision:"clear",quietHoursDecision:"outside",failureReasonClass:"policy_blocked",retryOf:null,retryAttempt:0,handoffCaseId:null,transcriptRef:null,phoneLast4:"0001",dialed:false}];
const gst = {
  entities:[],registrations:[],policies:[],adjustments:[],vendorReviews:[],packages:[],mappings:[],exports:[],closeEvidence:[],serviceInvoices:[],
  invoices:[{id:"UI-INVOICE-1",invoice_number:"UI/2026/0001",customer_id:reference,source_type:"booking",source_id:reference,issue_date:"2026-09-28",subtotal:100000,tax_total:18000,amount_received:118000,total:118000,status:"issued",source_event_key:"ui-only"}],
  productionReady:false,liveFilingEnabled:false,liveAccountingPostEnabled:false,
};
export function fixtureFor(url: URL): unknown | undefined {
  if (url.pathname === "/api/boarding-finance" && url.searchParams.get("view") === "queue") return boardingQueue;
  if (url.pathname in detailFixtures) return detailFixtures[url.pathname];
  if (url.pathname === "/api/payment-reconciliation") return url.searchParams.get("view") === "bookings" ? ledger : overview;
  if (url.pathname === "/api/voice-outbound") return url.searchParams.get("scope") === "ledger" ? calls : readiness;
  if (url.pathname === "/api/gst-accounting" && !url.search) return gst;
  return fixtures[url.pathname];
}
