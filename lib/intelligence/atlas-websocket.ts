import { database, resolveActor } from "../server-auth";
import { answerFinancialQuestion } from "./financial-query-agent";
import { answerAtlasBusinessQuestion } from "./atlas-business-snapshot";
import { executeAtlasApprovedAction, listAtlasMessages, recordAtlasMessage, requireFounderRole } from "./atlas-data";

type Pair={0:WebSocket;1:WebSocket};
export async function handleAtlasWebSocket(request:Request){
 if((request.headers.get("upgrade")||"").toLowerCase()!=="websocket")return new Response("WebSocket upgrade required",{status:426});
 const actor=requireFounderRole(await resolveActor(request)),db=await database(),PairCtor=(globalThis as unknown as{WebSocketPair?:new()=>Pair}).WebSocketPair;
 if(!PairCtor)return new Response("Cloudflare WebSocket runtime unavailable",{status:501});
 const pair=new PairCtor(),client=pair[0],server=pair[1];(server as WebSocket&{accept?:()=>void}).accept?.();const send=(value:unknown)=>server.send(JSON.stringify(value));
 send({type:"snapshot",messages:await listAtlasMessages(db,100)});
 server.addEventListener("message",event=>{void(async()=>{try{
  const payload=JSON.parse(String(event.data||"{}")) as Record<string,unknown>,type=String(payload.type||"");
  if(type==="sync"){send({type:"snapshot",messages:await listAtlasMessages(db,100)});return}
  if(type==="approve"){const messageId=String(payload.messageId||"").trim();await recordAtlasMessage(db,{role:"founder",actorEmail:actor.email,content:"Yes, execute.",replyToId:messageId});send({type:"action_result",data:await executeAtlasApprovedAction(db,{messageId,actorEmail:actor.email})});return}
  if(type==="ask"){
   const question=String(payload.message||"").trim();if(!question)throw new Error("Founder message is required");await recordAtlasMessage(db,{role:"founder",actorEmail:actor.email,content:question});
   const answer=await answerAtlasBusinessQuestion(db,{question,missionId:String(payload.missionId||"").trim()||undefined}),analytics=payload.includeTallyMemory===true?{...(await answerFinancialQuestion(db,question)),source:"tally_memory"}:null;
   const message=await recordAtlasMessage(db,{role:"atlas",actorEmail:"system:atlas",content:answer.content});send({type:"answer",messageId:message.messageId,content:answer.content,businessSnapshot:answer.snapshot,narrativeAvailable:answer.narrativeAvailable,narrativeReason:answer.narrativeReason,analytics});return;
  }
  throw new Error("Unsupported Atlas WebSocket message type");
 }catch(error){send({type:"error",error:error instanceof Error?error.message:"Atlas request failed"})}})()});
 return new Response(null,{status:101,webSocket:client} as ResponseInit&{webSocket:WebSocket});
}
