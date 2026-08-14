import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{mutateWorkQueueTask,sweepWorkQueue,workQueueSnapshot,workQueueTaskWithEvents,type WorkQueueAction}from"../../../lib/ops-work-queue";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){try{
 const db=await database(),actor=await resolveActor(request);requirePermission(actor,"bookings.view");
 const url=new URL(request.url),taskId=String(url.searchParams.get("taskId")||"").trim();
 if(taskId){const task=await workQueueTaskWithEvents(db,taskId);if(!task)return json({error:"Work queue task not found"},404);return json({data:task});}
 // D7: GET is read-only. Detection/escalation writes task rows and escalation state, so refreshing the
 // queue is a mutation and belongs on the write path — POST {action:"sweep"} (bookings.manage), which a
 // cron or an explicit "Refresh" action drives. A read must never open/escalate tasks as a side effect.
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
