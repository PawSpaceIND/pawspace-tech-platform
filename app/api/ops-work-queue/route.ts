import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{mutateWorkQueueTask,sweepWorkQueue,workQueueSnapshot,workQueueTaskWithEvents,type WorkQueueAction}from"../../../lib/ops-work-queue";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function workQueueExists(db:Awaited<ReturnType<typeof database>>){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_work_queue_tasks'").first<Record<string,unknown>>());}
function emptyWorkQueueSnapshot(){return{generatedAt:Date.now(),metrics:{total:0,open:0,escalated:0,critical:0,resolvedToday:0},queues:{},commandCentre:{available:false},truth:{source:"canonical tables only",detectors:["provider_unassigned","refund_requested","payment_exception","low_rating_callback","relocation_enquiry","food_renewal_payment_overdue","lead_response_overdue"],backgroundSchedulerConfigured:false,productionReady:false}};}

export async function GET(request:Request){try{
 const db=await database(),url=new URL(request.url),taskId=String(url.searchParams.get("taskId")||"").trim();
 if(!await workQueueExists(db)){if(taskId)return json({error:"Work queue task not found"},404);return json({data:emptyWorkQueueSnapshot()});}
 const actor=await resolveActor(request);requirePermission(actor,"bookings.manage");
 if(taskId){const task=await workQueueTaskWithEvents(db,taskId);if(!task)return json({error:"Work queue task not found"},404);return json({data:task});}
 return json({data:await workQueueSnapshot(db)});
}catch(error){return authError(error,"Unable to load the operations work queue");}}

export async function POST(request:Request){try{
 const db=await database(),actor=await resolveActor(request);requirePermission(actor,"bookings.manage");
 const body=await request.json() as{action?:string;taskId?:string;note?:string;owner?:string};
 const action=String(body.action||"").trim();
 if(action==="sweep"){const result=await sweepWorkQueue(db,{actorId:actor.email});await securityAudit(db,actor,"work_queue.sweep","work_queue","*","completed",result);return json({data:result});}
 if(["claim","acknowledge","start","resolve","dismiss","add_note"].includes(action)){
  const taskId=String(body.taskId||"").trim();if(!taskId)return json({error:"A task is required"},400);
  const result=await mutateWorkQueueTask(db,{taskId,action:action as WorkQueueAction,actorId:actor.email,note:body.note,owner:body.owner});
  await securityAudit(db,actor,`work_queue.${action}`,"work_queue_task",taskId,"completed",{note:body.note||null,owner:body.owner||null});
  return json({data:result});
 }
 return json({error:"Unsupported work queue action"},400);
}catch(error){return authError(error,"Unable to update the operations work queue");}}
