import { authError, authorize, database } from "../../../lib/server-auth";
import {
  saveGroomerBracket, currentGroomerBracket, recordHelperAttendance, saveGroomerMonthlyTarget,
  recordOfflineSubSale, saveGroomerGpayLedger, recordSpecialIncentive as recordGroomerSpecialIncentive,
  computeGroomerMonthlyIncentive, rankGroomersForMonth, ensureGroomingIncentiveTables,
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

type Db=Awaited<ReturnType<typeof database>>;

async function ensureAll(db:Db){
  await Promise.all([
    ensureGroomingIncentiveTables(db),
    ensureTrainerIncentiveTables(db),
    ensureSalesIncentiveTables(db),
    ensureEmployeeRecognitionTables(db),
  ]);
}

export async function GET(request:Request){
  try{
    const actor=await authorize(request,"people.view"),db=await database();
    await ensureAll(db);
    const url=new URL(request.url),employeeId=url.searchParams.get("employeeId")||"",monthStart=url.searchParams.get("monthStart")||"",kind=url.searchParams.get("kind")||"";
    if(!employeeId||!monthStart)return Response.json({error:"employeeId and monthStart are required"},{status:400});
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
      return Response.json({monthly});
    }
    return Response.json({error:"kind must be groomer, trainer, or sales"},{status:400});
  }catch(error){return authError(error,"Unable to load service incentive engine")}
}

export async function POST(request:Request){
  try{
    const actor=await authorize(request,"people.manage"),db=await database();
    await ensureAll(db);
    const body=await request.json() as Record<string,unknown>,action=String(body.action||"");

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
