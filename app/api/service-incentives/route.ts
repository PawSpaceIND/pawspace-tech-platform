import { authError, authorize, database } from "../../../lib/server-auth";
import { governedJsonError } from "../../../lib/governed-http-error";
import {
  saveGroomerBracket, currentGroomerBracket, recordHelperAttendance, saveGroomerMonthlyTarget,
  recordOfflineSubSale, saveGroomerGpayLedger, recordSpecialIncentive as recordGroomerSpecialIncentive,
  computeGroomerMonthlyIncentive, rankGroomersForMonth, saveGroomerIncentiveDraft,
  finalizeGroomerIncentive, ensureGroomingIncentiveTables,
} from "../../../lib/grooming-incentive-engine";
import {
  computeTrainerMonthlyIncentive, recordMeetGreetConversion, ensureTrainerIncentiveTables,
} from "../../../lib/trainer-incentive-engine";
import {
  saveSalesEmployeeBase, attributeBookingToSalesEmployee, saveSalesBlitzDay,
  computeDailySalesIncentive, computeMonthlySalesIncentive, ensureSalesIncentiveTables,
} from "../../../lib/sales-incentive-engine";
import {
  recordEmployeeSpecialIncentive, recordGoogleReviewIncentive, ensureEmployeeRecognitionTables,
} from "../../../lib/employee-recognition-incentives";
import { saveProviderHomeBase, currentHomeBase, homeBaseHistory } from "../../../lib/provider-home-base";
import { computeDailyTravel, dailyTravelSummary } from "../../../lib/provider-daily-travel";
import { buildSalesIncentivePeriodResult, approveSalesIncentivePeriodResult, salesIncentivePeriodTruth } from "../../../lib/daily-incentive-accrual";

type Db=Awaited<ReturnType<typeof database>>;

async function ensureAll(db:Db){
  await Promise.all([
    ensureGroomingIncentiveTables(db),
    ensureTrainerIncentiveTables(db),
    ensureSalesIncentiveTables(db),
    ensureEmployeeRecognitionTables(db),
  ]);
}

/**
 * Every action on this route attaches a record - nearly always money - to ONE named person. A
 * missing, empty or whitespace-only identity is not a value worth storing: the row belongs to
 * nobody, no compute path can ever find it again, and the operator is told it was saved.
 *
 * The rule is the one lib/grooming-incentive-engine.ts already applies in saveGroomerBracket and
 * recordSpecialIncentive - `String(v??"").trim()` must be non-empty - and it is applied here ONCE
 * for every action instead of in two handlers out of twenty-two. saveGroomerMonthlyTarget and
 * saveGroomerGpayLedger validate the month and the amounts but never the person, so a blank
 * headGroomerId wrote groomer_monthly_targets / groomer_gpay_ledger rows and answered 200.
 *
 * The refusal is RAISED, not returned, so it travels the same path as an engine failure and lands in
 * authError() below. It must therefore be a *governed* response: authError trusts a thrown Response
 * only by object identity (lib/governed-http-error.ts keeps a WeakSet), so a bare
 * `throw new Response(...)` keeps its status but has its body replaced by the generic fallback - the
 * operator would read "Unable to update service incentive engine" instead of what is actually wrong.
 */
const identityText=(value:unknown)=>String(value??"").trim();

/** action -> the body field naming the person the record belongs to. A Map, so no action name can
 *  reach an inherited Object property and be mistaken for a rule. */
const SUBJECT_OF_ACTION=new Map<string,{field:string;subject:string}>([
  ["save_groomer_bracket",{field:"headGroomerId",subject:"Head groomer"}],
  ["save_groomer_target",{field:"headGroomerId",subject:"Head groomer"}],
  ["record_offline_sub_sale",{field:"headGroomerId",subject:"Head groomer"}],
  ["save_gpay_ledger",{field:"headGroomerId",subject:"Head groomer"}],
  ["record_groomer_special_incentive",{field:"headGroomerId",subject:"Head groomer"}],
  ["save_groomer_incentive_draft",{field:"headGroomerId",subject:"Head groomer"}],
  ["finalize_groomer_incentive",{field:"headGroomerId",subject:"Head groomer"}],
  ["record_helper_attendance",{field:"helperId",subject:"Helper"}],
  ["record_meet_greet_conversion",{field:"trainerId",subject:"Trainer"}],
  ["save_sales_base",{field:"employeeId",subject:"Employee"}],
  ["attribute_booking",{field:"employeeId",subject:"Employee"}],
  ["compute_daily_sales",{field:"employeeId",subject:"Employee"}],
  ["generate_sales_period",{field:"employeeId",subject:"Employee"}],
  ["approve_sales_period",{field:"employeeId",subject:"Employee"}],
  ["record_special_incentive",{field:"employeeId",subject:"Employee"}],
  ["record_review_incentive",{field:"employeeId",subject:"Employee"}],
  ["save_home_base",{field:"providerId",subject:"Provider"}],
  ["home_base_history",{field:"providerId",subject:"Provider"}],
  ["compute_daily_travel",{field:"providerId",subject:"Provider"}],
  ["daily_travel_summary",{field:"providerId",subject:"Provider"}],
]);

/** Exported so a test can assert the table covers every action the switch below accepts. */
export function identifiedSubjectActions(){return [...SUBJECT_OF_ACTION.keys()];}

function requireIdentifiedSubject(action:string,body:Record<string,unknown>){
  const rule=SUBJECT_OF_ACTION.get(action);
  if(rule&&!identityText(body[rule.field]))throw governedJsonError({error:`${rule.subject} is required`,action,field:rule.field},400);
  // rank_groomers carries a LIST of people; one blank entry ranks nobody against everybody else.
  if(action==="rank_groomers"){
    const ids=Array.isArray(body.headGroomerIds)?body.headGroomerIds:[];
    if(ids.some(id=>!identityText(id)))throw governedJsonError({error:"Head groomer is required",action,field:"headGroomerIds"},400);
  }
}

export async function GET(request:Request){
  try{
    const actor=await authorize(request,"people.view"),db=await database();
    await ensureAll(db);
    const url=new URL(request.url),employeeId=identityText(url.searchParams.get("employeeId")),monthStart=identityText(url.searchParams.get("monthStart")),kind=identityText(url.searchParams.get("kind"));
    if(!employeeId||!monthStart)return Response.json({error:"employeeId and monthStart are required"},{status:400,headers:{"cache-control":"no-store"}});
    if(kind==="groomer"){
      const bracket=await currentGroomerBracket(db,employeeId,monthStart);
      const result=await computeGroomerMonthlyIncentive(db,{headGroomerId:employeeId,monthStart,actorId:actor.email});
      return Response.json({bracket,result});
    }
    if(kind==="trainer"){
      const result=await computeTrainerMonthlyIncentive(db,{trainerId:employeeId,monthStart,actorId:actor.email});
      const homeBase=await currentHomeBase(db,employeeId);
      return Response.json({result,homeBase});
    }
    if(kind==="sales"){
      const monthly=await computeMonthlySalesIncentive(db,{employeeId,monthStart,actorId:actor.email});
      const governance=await salesIncentivePeriodTruth(db,{employeeId,monthStart});
      return Response.json({monthly,governance});
    }
    return Response.json({error:"kind must be groomer, trainer, or sales"},{status:400});
  }catch(error){return authError(error,"Unable to load service incentive engine")}
}

export async function POST(request:Request){
  try{
    const actor=await authorize(request,"people.manage"),db=await database();
    await ensureAll(db);
    const body=await request.json() as Record<string,unknown>,action=String(body.action||"");
    requireIdentifiedSubject(action,body);

    switch(action){
      case "save_groomer_bracket":
        return Response.json(await saveGroomerBracket(db,{headGroomerId:String(body.headGroomerId),bracket:body.bracket as "team"|"single",helperId:body.helperId?String(body.helperId):null,effectiveFrom:String(body.effectiveFrom),reason:String(body.reason||""),actorId:actor.email}));
      case "record_helper_attendance":
        return Response.json(await recordHelperAttendance(db,{helperId:String(body.helperId),attendanceDate:String(body.attendanceDate),status:body.status as "present"|"absent",actorId:actor.email}));
      case "save_groomer_target":
        return Response.json(await saveGroomerMonthlyTarget(db,{headGroomerId:String(body.headGroomerId),monthStart:String(body.monthStart),targetAmount:Number(body.targetAmount),reason:String(body.reason||""),actorId:actor.email}));
      case "record_offline_sub_sale":
        return Response.json(await recordOfflineSubSale(db,{headGroomerId:String(body.headGroomerId),saleDate:String(body.saleDate),amount:Number(body.amount),reason:String(body.reason||"Offline subscription sold"),actorId:actor.email}));
      case "save_gpay_ledger":
        return Response.json(await saveGroomerGpayLedger(db,{headGroomerId:String(body.headGroomerId),monthStart:String(body.monthStart),gpayTotal:Number(body.gpayTotal),gpayPending:Number(body.gpayPending),actorId:actor.email}));
      case "record_groomer_special_incentive":
        return Response.json(await recordGroomerSpecialIncentive(db,{headGroomerId:String(body.headGroomerId),monthStart:String(body.monthStart),amount:Number(body.amount),reason:String(body.reason||""),actorId:actor.email}));
      case "rank_groomers":
        return Response.json({ranking:await rankGroomersForMonth(db,{monthStart:String(body.monthStart),headGroomerIds:(body.headGroomerIds as string[])||[],actorId:actor.email})});
      case "save_groomer_incentive_draft":
        return Response.json(await saveGroomerIncentiveDraft(db,{headGroomerId:String(body.headGroomerId),monthStart:String(body.monthStart),actorId:actor.email}));
      case "finalize_groomer_incentive":
        return Response.json(await finalizeGroomerIncentive(db,{headGroomerId:String(body.headGroomerId),monthStart:String(body.monthStart),actorId:actor.email}));

      case "record_meet_greet_conversion":
        return Response.json(await recordMeetGreetConversion(db,{trainerId:String(body.trainerId),meetGreetBookingId:String(body.meetGreetBookingId),convertedBookingId:String(body.convertedBookingId),actorId:actor.email}));

      case "save_sales_base":
        return Response.json(await saveSalesEmployeeBase(db,{employeeId:String(body.employeeId),baseVertical:body.baseVertical as "training"|"grooming_outbound"|"grooming_inbound"|"grooming_both",effectiveFrom:String(body.effectiveFrom),reason:String(body.reason||""),actorId:actor.email}));
      case "attribute_booking":
        return Response.json(await attributeBookingToSalesEmployee(db,{bookingId:String(body.bookingId),employeeId:String(body.employeeId),actorId:actor.email}));
      case "save_blitz_day":
        return Response.json(await saveSalesBlitzDay(db,{blitzDate:String(body.blitzDate),reason:String(body.reason||""),actorId:actor.email}));
      case "compute_daily_sales":
        return Response.json(await computeDailySalesIncentive(db,{employeeId:String(body.employeeId),date:String(body.date),actorId:actor.email}));
      case "generate_sales_period":
        return Response.json(await buildSalesIncentivePeriodResult(db,{employeeId:String(body.employeeId),monthStart:String(body.monthStart),actorId:actor.email}));
      case "approve_sales_period":
        return Response.json(await approveSalesIncentivePeriodResult(db,{employeeId:String(body.employeeId),monthStart:String(body.monthStart),actorId:actor.email}));

      case "save_home_base":
        return Response.json(await saveProviderHomeBase(db,{providerId:String(body.providerId),address:String(body.address),latitude:Number(body.latitude),longitude:Number(body.longitude),effectiveFrom:Number(body.effectiveFrom),reason:String(body.reason||""),actorId:actor.email}));
      case "home_base_history":
        return Response.json({history:await homeBaseHistory(db,String(body.providerId))});
      case "compute_daily_travel":
        return Response.json(await computeDailyTravel(db,{providerId:String(body.providerId),travelDate:String(body.travelDate),actorId:actor.email}));
      case "daily_travel_summary":
        return Response.json(await dailyTravelSummary(db,{providerId:String(body.providerId),travelDate:String(body.travelDate)}));

      case "record_special_incentive":
        return Response.json(await recordEmployeeSpecialIncentive(db,{employeeId:String(body.employeeId),monthStart:String(body.monthStart),amount:Number(body.amount),reason:String(body.reason||""),actorId:actor.email}));
      case "record_review_incentive":
        return Response.json(await recordGoogleReviewIncentive(db,{employeeId:String(body.employeeId),reviewDate:String(body.reviewDate),amount:Number(body.amount),reviewReference:body.reviewReference?String(body.reviewReference):undefined,actorId:actor.email}));

      default:
        return Response.json({error:`Unknown action: ${action}`},{status:400});
    }
  }catch(error){return authError(error,"Unable to update service incentive engine")}
}
