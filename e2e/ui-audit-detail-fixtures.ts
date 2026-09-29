// Read-only synthetic payloads for layout tests. Never persisted or used for authentication.
const at = Date.UTC(2026, 8, 28, 10);
export const detailFixtures: Record<string, unknown> = {
 "/api/location-recovery": {sessions:Array.from({length:45},(_,i)=>({id:`UI-SESSION-${i}`,booking_id:`UI-BOOKING-${i}`,provider_id:`UI-PROVIDER-${i}`,service_code:"grooming",status:"active",starts_at:at})),recoveries:[],punctualityEvents:[],control:null},
 "/api/provider-onboarding": {applications:[{id:"UI-APPLICATION-1",vertical_key:"grooming",city_code:"BLR",status:"draft"}],documents:[],verifications:[],attempts:[],events:[{id:"UI-LOG-1",application_id:"UI-APPLICATION-1",event_type:"uat_pay_beneficiary_seeded_very_long_identifier_for_responsive_test",actor_id:"ui-audit",from_status:"draft",to_status:"verified"}],humanActivation:{interviews:[],agreements:[],profiles:[],media:[]}},
 "/api/employee-performance": {metric:"net_collected_revenue",teamCode:"sales",rows:[],totals:{leads:0,conversions:0,net:0,refunds:0},truth:{rankingAuthority:false,payrollAuthority:false,disciplinaryAuthority:false,source:"synthetic-ui"},period:{days:30,from:at-30*86400000,to:at,sourceRun:null}},
 "/api/sales-productivity-governance": {policies:[{id:"UI-POLICY",name:"Visual test",status:"active_uat",version:1,teamCode:"sales",meaningfulActionTypes:[],qualifiedOutcomes:[],revenueBasis:"net_collected"}],setup:{teamRoster:[{teamCode:"sales",members:3}],teamMembers:["One","Two","Three"].map(name=>({teamCode:"sales",employeeEmail:`ui-${name.toLowerCase()}@example.invalid`,name:`UI Reviewer ${name}`})),observedActionTypes:[],observedOutcomes:[],observedServiceCodes:[],observedCityIds:[]}},
 "/api/control-tower": {date:"2026-09-28",timezone:"Asia/Kolkata",headline:{signalsTracked:1,signalsClear:0,needsAttention:1,openItems:19},signals:[{code:"UI-SIGNAL",severity:"critical",label:"UI unresolved records",detail:"Synthetic visual review, no business action",count:19,view:"audit"}],posture:[],recentChanges:[],sourceStatus:{}},
 "/api/me": {linked:true,email:"ui-employee@example.invalid",engagement:"employee",employee:{id:"UI-EMPLOYEE",code:"UI01",name:"UI Employee",workEmail:"ui-employee@example.invalid",joinedAt:at},compensation:null,payslips:{list:[],latest:null,latestLines:[]},incentives:{list:[],approvedTotal:0},dailyIncentive:{list:[],total:0},advances:{list:[],outstanding:0},leave:{balances:[],requests:[]},attendance:[{workDate:"2026-09-28",status:"present",workedMinutes:0,exception:"missing_checkout"}],performance:{appears:false,teamCode:"sales",ofEmployees:0}},
 "/api/admin/atlas-chat": {messages:[{id:"UI-MESSAGE",role:"atlas",createdAt:at,content:"**Important review**\n\n- First item\n- Second item with `reference`\n\nLiteral markup: <untrusted-tag>."}]},
};
export const boardingQueue = {limit:100,items:["Short stay","A much longer boarding package name with a full descriptive label"].map((name,i)=>({booking_id:`UI-BOARD-${i}`,package_name:name,stay_status:"confirmed",payment_status:"captured",pending_cancellations:1,pending_refunds:0,pending_refund_amount:0,pending_date_changes:0}))};

export const complianceFixture = {
 period:"2026-09",calendar:[],
 close:{period:"2026-09",status:"open",checklist:[],revenue:{bookings:0,bookingCount:0,foodOrders:0,foodOrderCount:0,total:0},gst:{outputTax:0,eligibleInputTax:0,netPayable:0,invoiceCount:0},tds:{total:999.9,sections:{},deposited:false,depositDueDate:"2026-10-07"},payroll:{runStatus:null,employees:0,grossTotal:0},boardApproval:{approved:false,approvedBy:null},closedBy:null,closedAt:null},
 tds:{deductions:[{section:"UI-SECTION",deductee_type:"contractor",deductee_id:"UI-DEDUCTEE-1",base_amount:9999,rate_pct:10,tds_amount:999.9,pan_status:"recorded"}],deposit:null,quarterlyReturns:[]},
};
detailFixtures["/api/statutory-compliance"] = complianceFixture;
detailFixtures["/api/conversations"] = {threads:Array.from({length:80},(_,i)=>({id:`UI-THREAD-${i}`,customer_id:`UI-CUSTOMER-${i}`,customer_name:`UI Conversation ${i}`,assigned_to:"ui-audit",status:"open"}))};
detailFixtures["/api/ai-human-handoff"] = {queue:[],current:null,events:[],aiPaused:true,sameCanonicalThread:true};

// Explicit empty/configuration-required finance views; avoid relying on unseeded local tables.
detailFixtures["/api/training-finance"] = {invoices:[],earnings:[],payouts:[],taxPolicies:[],compensationRules:[],events:[],livePayout:false,executionMode:"sandbox",cancellation:{policies:[],cases:[],refunds:[],creditNotes:[],liveRefund:false,liveTaxFiling:false}};
detailFixtures["/api/training-reconciliation"] = {summary:{programmes:0,reconciled:0,exceptions:0},records:[],source:"synthetic-ui-layout",liveMoney:false};

export const emptyComplianceFixture = {
 ...complianceFixture,
 close:{...complianceFixture.close,tds:{...complianceFixture.close.tds,total:0}},
 tds:{...complianceFixture.tds,deductions:[]},
};
