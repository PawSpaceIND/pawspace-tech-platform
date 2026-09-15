import{authError,authorize,database}from"../../../../lib/server-auth";

type Row=Record<string,unknown>;
const encoder=new TextEncoder();
const frame=(event:string,data:unknown)=>encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

async function version(db:D1Database){const row=await db.prepare("SELECT MAX(v) version FROM (SELECT COALESCE(MAX(updated_at),0) v FROM communication_threads UNION ALL SELECT COALESCE(MAX(updated_at),0) v FROM communication_messages)").first<Row>();return Number(row?.version||0);}

/*
 * R3-G / F5: authorize() THROWS a governed Response and was called outside any try/catch, so a
 * refusal escaped as an unhandled error and the runtime answered 500 with an empty body - a server
 * fault logged for a user who is simply not allowed in. See the note on
 * app/api/booking-command-center/stream/route.ts.
 */
export async function GET(request:Request){
 try{return await stream(request);}catch(error){return authError(error,"Unable to open the conversations stream");}
}

async function stream(request:Request){
 await authorize(request,"communications.manage");
 const db=await database();let closed=false,last=await version(db),timer:ReturnType<typeof setInterval>|undefined;
 const body=new ReadableStream<Uint8Array>({
  start(controller){
   controller.enqueue(frame("ready",{version:last}));
   timer=setInterval(()=>{void(async()=>{if(closed)return;try{const next=await version(db);if(next>last){last=next;controller.enqueue(frame("conversation",{version:next}));}else controller.enqueue(frame("heartbeat",{version:last}));}catch{controller.enqueue(frame("heartbeat",{version:last}));}})();},3000);
   request.signal.addEventListener("abort",()=>{closed=true;if(timer)clearInterval(timer);try{controller.close();}catch{}},{once:true});
  },
  cancel(){closed=true;if(timer)clearInterval(timer);},
 });
 return new Response(body,{headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-store, no-transform","connection":"keep-alive","x-accel-buffering":"no"}});
}
