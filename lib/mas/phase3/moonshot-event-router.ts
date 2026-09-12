import type {AuthenticatedActor} from "../../server-auth";
import {executePhase2Tool} from "../../atlas-phase2-vertical-tools";

type Row=Record<string,unknown>;
type TelemetrySignal={petId:string;heart:number|null;observed:number};
const text=(v:unknown)=>String(v??"").trim();
const truthy=(v:unknown)=>["1","true","on","yes"].includes(text(v).toLowerCase());
const systemActor:AuthenticatedActor={email:"moonshot-router@pawspace.internal",name:"Moonshot Event Router",roleCode:"system",permissions:["*"],developmentPreview:false,identitySource:"workspace",principalType:"email",principalKey:"moonshot-router@pawspace.internal"};
export type MoonshotWake={agent:"healthcare"|"ops";toolCode:"vet.triage.evaluate"|"ops.voice.dispatch";executed:boolean;reason?:string;result?:unknown};
export async function routeTelemetryToHealthcare(db:D1Database,env:Row,signals:TelemetrySignal[]){
 if(!truthy(env.PAWSPACE_IOT_ACTIVE))return[] as MoonshotWake[];
 const threshold=Math.max(1,Number(env.PAWSPACE_IOT_HEART_RATE_ALERT_BPM)||180),byPet=new Map<string,TelemetrySignal[]>();
 for(const signal of signals){if(signal.heart===null||signal.heart<threshold)continue;const list=byPet.get(signal.petId)||[];list.push(signal);byPet.set(signal.petId,list);}
 const wakes:MoonshotWake[]=[];
 for(const [petId,list] of byPet){if(new Set(list.map(item=>Math.floor(item.observed/5000))).size<2)continue;const pet=await db.prepare("SELECT id,customer_id FROM canonical_pets WHERE id=?").bind(petId).first<Row>();if(!pet)continue;
  const outcome=await executePhase2Tool(db,{agentCode:"healthcare",goalId:`moonshot:iot:${petId}`,toolCode:"vet.triage.evaluate",arguments:{customerId:text(pet.customer_id),petId,symptoms:`IoT collar detected sustained elevated heart rate at or above ${threshold} BPM across multiple debounce windows.`},actor:systemActor,env});
  wakes.push({agent:"healthcare",toolCode:"vet.triage.evaluate",executed:outcome.executed,reason:"reason" in outcome?outcome.reason:undefined,result:"result" in outcome?outcome.result:undefined});
 }
 return wakes;
}
function severeVision(result:unknown){const raw=typeof result==="string"?result:JSON.stringify(result??{});const value=raw.toLowerCase();return value.includes("distressed pet")||value.includes("gate left open")||value.includes("open gate")||value.includes("unattended medical emergency")||value.includes("smoke")||value.includes("fire");}
export async function routeVisionToOps(db:D1Database,env:Row,input:{sourceId:string;bookingId?:string;result:unknown}){
 if(!truthy(env.PAWSPACE_VISION_ACTIVE)||!severeVision(input.result))return null;
 await db.prepare("CREATE TABLE IF NOT EXISTS moonshot_ops_alerts (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,booking_id TEXT,severity TEXT NOT NULL,status TEXT NOT NULL,tool_code TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
 const id=`MSA-${crypto.randomUUID().slice(0,12).toUpperCase()}`;await db.prepare("INSERT INTO moonshot_ops_alerts (id,source_id,booking_id,severity,status,tool_code,payload_json,created_at) VALUES (?,?,?,'critical','open','ops.voice.dispatch',?,?)").bind(id,input.sourceId,input.bookingId||null,JSON.stringify(input.result),Date.now()).run();
 return{id,agent:"ops" as const,priority:"critical" as const,toolCode:"ops.voice.dispatch" as const,bookingId:input.bookingId||null,voiceDispatchCapable:Boolean(input.bookingId)};
}
