import type { AiActionRequest } from "./ai-conversation-orchestrator";

/** Dialogue constrains an unconfirmed proposal; it never grants booking authority. */
export function stayDurationClarification(history:{role:string;content:string}[],currentText:string,actions:AiActionRequest[]):string|null {
 const schedule=actions.find(action=>action.toolCode==="schedule.reserve")?.arguments;
 if(!schedule||!["boarding","pet_sitting"].includes(String(schedule.serviceCode)))return null;
 let requestedHours:number|null=null,ambiguousRevision=false;
 for(const message of [...history,{role:"user",content:currentText}]){
  if(message.role!=="user")continue;
  const content=message.content.trim();
  // The caller may explicitly choose the changed dates after our clarification.
  if(/^(?:please\s+)?(?:use|keep|choose|go with)\s+(?:the\s+)?(?:new|changed|updated)\s+dates[.! ]*$/i.test(content)){requestedHours=null;ambiguousRevision=false;continue;}
  for(const match of content.matchAll(/\b(\d+(?:\.\d+)?)\s*[- ]?\s*(?:hours?|hrs?)\s+(?:boarding\s+|sitting\s+)?(?:stay|care)\b/gi)){
   const prefix=content.slice(0,match.index);
   const hours=Number(match[1]);
   if(/\b(?:not|don't|don’t|do not|ignore|rather than|instead of|no longer)(?:\s+(?:want|need|choose|book|use|a|an|the))*\s*$/i.test(prefix)){
    // Rejecting a different duration does not erase the caller's established choice.
    if(requestedHours===null||requestedHours===hours)ambiguousRevision=true;
    continue;
   }
   if(/\b(?:about|around|roughly|up to)(?:\s+(?:a|an|the))?\s*$/i.test(prefix)){requestedHours=null;ambiguousRevision=false;continue;}
   requestedHours=Number.isFinite(hours)&&hours>0?hours:null;ambiguousRevision=false;
  }
 }
 if(ambiguousRevision)return "The stay duration is unclear after that correction. How many hours of care do you want?";
 if(requestedHours===null)return null;
 const start=String(schedule.scheduledStart??""),end=String(schedule.scheduledEnd??"");
 // Missing or timezone-ambiguous timestamps belong to the existing scheduler validation.
 if(!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(start)||!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(end))return null;
 const duration=Date.parse(end)-Date.parse(start);
 if(!Number.isFinite(duration)||duration<=0||Math.abs(duration-requestedHours*3600000)<=60000)return null;
 const actualHours=Number((duration/3600000).toFixed(2));
 return `You asked for a ${requestedHours}-hour stay, but these start and end times cover ${actualHours} hours. Should I keep the ${requestedHours}-hour stay or use the new dates?`;
}
