/**
 * The PawSpace web chat bot: WATI-style guided flows with buttons, in front of PawSpace AI.
 *
 * The WATI parity project built its chatbot for WhatsApp only and listed website chat as out of scope,
 * so /v2/chat never had one: every message went straight to the language model. This is the web chat's
 * guided layer. A visitor picks a service from buttons and answers a short, WATI-style questionnaire
 * ("Please type your Name", "Please select the travel type: Domestic / International", "Travel date in
 * DD/MM format"). A question typed at the menu goes to PawSpace AI; asking for a person, a refund or an
 * emergency goes to a human at once.
 *
 * This module is a pure state machine: no database, no network. The route persists the state and acts
 * on the events it returns (`ai`, `human`, `completed`), which keeps every flow testable on its own.
 */

export type BotChoice={id:string;label:string};
type StepKind="choice"|"text"|"name"|"phone"|"email"|"date";
type Step={key:string;label:string;prompt:string;kind:StepKind;choices?:BotChoice[];hint?:string;
 /** Asked only when the visitor is not signed in: a signed-in customer's identity is already known. */
 anonymousOnly?:boolean};
type Flow={code:string;service:string;label:string;steps:Step[]};

export type BotState={version:1;status:"menu"|"collecting"|"done";flow:string|null;step:number;answers:Record<string,string>;
 /** The CRM lead created for a visitor as soon as their number is known (web chat). */
 leadId?:string;
 /** When a stalled flow was last nudged by the follow-up sweep. */
 nudgedAt?:number;
 /** The service a lead enquired about (its WhatsApp template was for it): a short reply starts that flow. */
 preferredFlow?:string};
export type BotReply={text:string;choices:BotChoice[];inputHint:string|null};
export type BotEvent=
 |{type:"none"}
 |{type:"ai";question:string}
 |{type:"call"}
 |{type:"human";reason:"customer_requested_human"|"refund_payment_dispute"|"complaint"|"safety"|"urgent_funeral_memorial"}
 |{type:"completed";flow:string;service:string;answers:Record<string,string>;summary:string};
export type BotTurnResult={state:BotState;reply:BotReply;event:BotEvent;
 /** The customer's input as it should appear in the conversation (a button shows its label). */
 display:string};

const choice=(label:string):BotChoice=>({id:label.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,""),label});
const PET=[choice("Dog"),choice("Cat")];
const PET_COUNT=[choice("1"),choice("2"),choice("3 & above")];

const NAME:Step={key:"name",label:"Name",prompt:"Please type your Name",kind:"name",hint:"Your name",anonymousOnly:true};
const AREA:Step={key:"area",label:"Area",prompt:"Which area or pincode should we come to?",kind:"text",hint:"Area or pincode"};
const DATE=(prompt:string):Step=>({key:"date",label:"Date",prompt,kind:"date",hint:"DD/MM"});

export const WEB_CHAT_FLOWS:Flow[]=[
 {code:"grooming",service:"Grooming",label:"Grooming",steps:[NAME,
  {key:"petType",label:"Pet",prompt:"Is the grooming for a dog or a cat?",kind:"choice",choices:PET},
  {key:"petCount",label:"Number of pets",prompt:"Please select the number of pets",kind:"choice",choices:PET_COUNT},
  {key:"package",label:"Package",prompt:"Which grooming package are you interested in?",kind:"choice",choices:[choice("Essential Bath"),choice("Bath & Basic"),choice("Complete Makeover"),choice("Just Trim"),choice("Not sure yet")]},
  DATE("Preferred grooming date - please type in DD/MM format"),AREA]},
 {code:"training",service:"Dog Training",label:"Dog Training",steps:[NAME,
  {key:"dogAge",label:"Dog's age",prompt:"How old is your dog?",kind:"choice",choices:[choice("Under 6 months"),choice("6 to 12 months"),choice("Over 1 year")]},
  {key:"breed",label:"Breed",prompt:"Please type your dog's breed",kind:"text",hint:"For example Golden Retriever"},
  {key:"goal",label:"Training goal",prompt:"What would you like help with?",kind:"choice",choices:[choice("Basic obedience"),choice("Behaviour issues"),choice("Puppy manners"),choice("Leash walking"),choice("Something else")]},
  AREA]},
 {code:"boarding",service:"Boarding",label:"Boarding",steps:[NAME,
  {key:"petType",label:"Pet",prompt:"Is the stay for a dog or a cat?",kind:"choice",choices:PET},
  {key:"stay",label:"Stay",prompt:"Please select the stay you need",kind:"choice",choices:[choice("Standard Stay (up to 4 hours)"),choice("Premium Stay (up to 10 hours)"),choice("Luxury Stay (overnight)")]},
  DATE("Stay start date - please type in DD/MM format"),AREA]},
 {code:"pet_sitting",service:"Pet Sitting",label:"Pet Sitting",steps:[NAME,
  {key:"petType",label:"Pet",prompt:"Is the sitting for a dog or a cat?",kind:"choice",choices:PET},
  {key:"visitType",label:"Sitting type",prompt:"Please select the sitting you need",kind:"choice",choices:[choice("Home visits"),choice("Overnight sitting")]},
  DATE("Start date - please type in DD/MM format"),AREA]},
 {code:"dog_walking",service:"Dog Walking",label:"Dog Walking",steps:[NAME,
  {key:"walks",label:"Walks per day",prompt:"How many walks a day?",kind:"choice",choices:[choice("Once a day"),choice("Twice a day")]},
  {key:"duration",label:"Walk length",prompt:"How long should each walk be?",kind:"choice",choices:[choice("30 minutes"),choice("60 minutes")]},
  AREA]},
 {code:"pet_taxi",service:"Pet Taxi",label:"Pet Taxi",steps:[NAME,
  {key:"purpose",label:"Purpose",prompt:"Select the purpose of your travel with pet",kind:"choice",choices:[choice("Vet Visits"),choice("Airport/station"),choice("Leisure (in-city) trip")]},
  DATE("Travel date - please type in DD/MM format"),
  {key:"route",label:"Pick up and drop",prompt:"Please share the pick up and drop location",kind:"text",hint:"Pick up and drop location"}]},
 {code:"fresh_food",service:"Fresh Food",label:"Fresh Food",steps:[NAME,
  {key:"petType",label:"Pet",prompt:"Is the food for a dog or a cat?",kind:"choice",choices:PET},
  {key:"plan",label:"Plan",prompt:"What would you like to try?",kind:"choice",choices:[choice("Trial pack"),choice("Monthly subscription"),choice("Not sure yet")]},
  AREA]},
 {code:"relocation",service:"Pet Relocation",label:"Pet Relocation",steps:[NAME,
  {key:"travelType",label:"Travel type",prompt:"Please select the travel type",kind:"choice",choices:[choice("Domestic"),choice("International")]},
  {key:"email",label:"Email",prompt:"Please type your Email ID",kind:"email",hint:"name@example.com"},
  {key:"from",label:"From",prompt:"Which city is your pet travelling from?",kind:"text",hint:"From city"},
  {key:"to",label:"To",prompt:"Which city or country is your pet travelling to?",kind:"text",hint:"Destination"},
  DATE("Travel date - please type in DD/MM format"),
  {key:"petCount",label:"Number of pets",prompt:"Please select the number of pets",kind:"choice",choices:PET_COUNT}]},
];

/** A visitor who is not signed in and asks for a person: the team needs a name and number to reach them. */
const TEAM_FLOW:Flow={code:"team",service:"Talk to our team",label:"Talk to our team",steps:[
 {key:"topic",label:"Needs help with",prompt:"What would you like our team to help you with?",kind:"text",hint:"Your question"},NAME]};

/** Contact details and WhatsApp consent, asked last and only of a visitor who is not signed in. */
const PHONE:Step={key:"phone",label:"Phone",prompt:"Please type your 10-digit mobile number so our team can reach you",kind:"phone",hint:"Mobile number",anonymousOnly:true};
const CONSENT:Step={key:"whatsapp",label:"WhatsApp updates",prompt:"Can we continue this on WhatsApp?",kind:"choice",choices:[choice("Yes, WhatsApp me"),choice("No, call me instead")],anonymousOnly:true};

export const ASK_AI:BotChoice={id:"ask_ai",label:"Ask a question"};
export const TALK_TO_TEAM:BotChoice={id:"talk_to_team",label:"Talk to our team"};
export const REQUEST_CALL:BotChoice={id:"request_call",label:"Request a call"};
const START_OVER:BotChoice={id:"start_over",label:"Start over"};
export const WEB_CHAT_MENU:BotChoice[]=[...WEB_CHAT_FLOWS.map(flow=>({id:flow.code,label:flow.label})),ASK_AI,REQUEST_CALL,TALK_TO_TEAM];
const GREETING="Hi! I'm PawSpace AI. What can I help you with today? Pick a service to get started, or just type your question.";

const HUMAN_PATTERNS:Array<[RegExp,Extract<BotEvent,{type:"human"}>["reason"]]>=[
 [/\b(human|agent|real person|representative|talk to (someone|a person)|speak to (someone|a person))\b/i,"customer_requested_human"],
 [/\b(refund|money back|payment dispute|charged twice|wrong charge)\b/i,"refund_payment_dispute"],
 [/\b(complaint|bad service|poor service|not happy|unhappy)\b/i,"complaint"],
 [/\b(emergency|injured|injury|bleeding|poison(ed)?|not breathing|seizure|collapsed)\b/i,"safety"],
 [/\b(funeral|memorial|cremation|passed away)\b/i,"urgent_funeral_memorial"],
];
const RESTART=/^(menu|main menu|restart|start over|start again|hi|hello|hey)$/i;

const FLOW_KEYWORDS:Record<string,RegExp>={grooming:/\bgroom/,training:/\btrain/,boarding:/\bboard/,pet_sitting:/\bsitt(ing|er)\b/,dog_walking:/\bwalk/,pet_taxi:/\b(taxi|cab)\b/,fresh_food:/\bfood\b/,relocation:/\brelocat/};
/**
 * "Book grooming", "need a dog walker": a short request that names a service starts its flow, as the
 * reply button of a WATI service template does. Questions and negations are left for PawSpace AI.
 */
export function flowFromText(value:string){
 const text=value.trim().toLowerCase();if(!text||text.length>40||text.includes("?")||/\b(not|no|don'?t|never)\b/.test(text))return null;
 const matches=Object.entries(FLOW_KEYWORDS).filter(([,pattern])=>pattern.test(text)).map(([code])=>code);
 return matches.length===1?flowByCode(matches[0]):null;
}
const SHORT_YES=/^(yes|yeah|yep|ok|okay|sure|book|book now|start|continue|interested|get started|let'?s go|go ahead)[.! ]*$/i;

export function initialBotState():BotState{return{version:1,status:"menu",flow:null,step:0,answers:{}};}
export function parseBotState(value:unknown):BotState{
 try{const parsed=typeof value==="string"?JSON.parse(value):value;if(parsed&&typeof parsed==="object"&&(parsed as BotState).version===1&&["menu","collecting","done"].includes((parsed as BotState).status))return parsed as BotState;}catch{}
 return initialBotState();
}
export function menuReply(text=GREETING):BotReply{return{text,choices:WEB_CHAT_MENU,inputHint:"Type a question or pick a service"};}
export function flowByCode(code:string|null){return code===TEAM_FLOW.code?TEAM_FLOW:WEB_CHAT_FLOWS.find(flow=>flow.code===code)||null;}

/* The phone number comes straight after the name: a visitor who stops half way still leaves a lead the
 * team can call, which is how a WATI flow works (WhatsApp already knows the number). */
function stepsFor(flow:Flow,signedIn:boolean){const named=flow.steps.findIndex(step=>step.key==="name"),steps=[...flow.steps];steps.splice(named+1,0,PHONE);return[...steps,CONSENT].filter(step=>!(signedIn&&step.anonymousOnly));}
function askReply(step:Step,prefix=""):BotReply{return{text:`${prefix}${step.prompt}`,choices:[...(step.choices||[]),START_OVER],inputHint:step.kind==="choice"?"Pick an option above":step.hint||null};}

function matchChoice(choices:BotChoice[],input:{text:string;choiceId?:string|null},numbered=true){
 const id=String(input.choiceId||"").trim();if(id){const byId=choices.find(item=>item.id===id);if(byId)return byId;}
 // Trailing "." and "!" are dropped with a loop, not /[.!]+$/, which backtracks quadratically on "....x".
 let typed=input.text.trim().toLowerCase(),end=typed.length;while(end>0&&(typed[end-1]==="."||typed[end-1]==="!"))end--;typed=typed.slice(0,end);if(!typed)return null;
 const index=Number(typed);if(numbered&&Number.isInteger(index)&&index>=1&&index<=choices.length)return choices[index-1];
 // WhatsApp cuts button titles at 20 characters and list titles at 24, and sends the title back.
 return choices.find(item=>item.label.toLowerCase()===typed||item.id===typed.replace(/[^a-z0-9]+/g,"_"))
  ||(typed.length>=18?choices.find(item=>item.label.toLowerCase().startsWith(typed)):undefined)||null;
}

/** DD/MM or DD/MM/YYYY, a real calendar date. */
/**
 * DD/MM or DD/MM/YYYY, a real calendar date. Without a year it means the next time that date comes round
 * (today counts), so 29/02 is valid only when a leap year is next, and the stored answer carries the year.
 */
export function parseDayMonth(value:string,now=Date.now()){
 const match=value.trim().match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);if(!match)return null;
 const day=Number(match[1]),month=Number(match[2]);
 const real=(year:number)=>{const date=new Date(Date.UTC(year,month-1,day));return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date:null;};
 let year:number;
 if(match[3])year=Number(match[3].length===2?`20${match[3]}`:match[3]);
 else{const today=new Date(now),start=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate());year=today.getUTCFullYear();const thisYear=real(year);if(!thisYear||thisYear.getTime()<start)year+=1;}
 return real(year)?`${String(day).padStart(2,"0")}/${String(month).padStart(2,"0")}/${year}`:null;
}

function validate(step:Step,raw:string):{value:string}|{error:string}{
 const value=raw.trim().replace(/\s+/g," ");
 if(step.kind==="name")return/^[\p{L}][\p{L} .'-]{1,79}$/u.test(value)?{value}:{error:"Please type your name using letters only."};
 if(step.kind==="phone"){const digits=value.replace(/\D/g,"").replace(/^91(?=\d{10}$)/,"").replace(/^0(?=\d{10}$)/,"");return/^[6-9]\d{9}$/.test(digits)?{value:`+91${digits}`}:{error:"Please type a valid 10-digit Indian mobile number."};}
 // Domain labels are split on the dot so the pattern has one way to match (no polynomial backtracking).
 if(step.kind==="email")return value.length<=160&&/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value)&&(value.split(".").at(-1)?.length??0)>=2?{value:value.toLowerCase()}:{error:"That doesn't look like an email address. Please type it like name@example.com."};
 if(step.kind==="date"){const date=parseDayMonth(value);return date?{value:date}:{error:"Please type the date in DD/MM format, for example 28/09."};}
 return value.length>=2&&value.length<=160?{value}:{error:"Please type a little more detail."};
}

export function botSummary(flow:Flow,answers:Record<string,string>,signedIn:boolean){
 const lines=stepsFor(flow,signedIn).filter(step=>answers[step.key]).map(step=>`${step.label}: ${answers[step.key]}`);
 return`${flow.service} enquiry\n${lines.join("\n")}`;
}

/**
 * One visitor input, one bot reply.
 * `choiceId` comes from a tapped button; typed text is matched against the same buttons (by label or
 * number, the way WATI accepts "1"), so a visitor who types instead of tapping is not stuck.
 */
export function runBotTurn(previous:BotState,input:{text?:string|null;choiceId?:string|null;signedIn:boolean}):BotTurnResult{
 const text=String(input.text||"").trim().slice(0,800),state:BotState={...previous,answers:{...previous.answers}};
 const choices=state.status==="collecting"?(stepsFor(flowByCode(state.flow)!,input.signedIn)[state.step]?.choices||[]):WEB_CHAT_MENU;
 // Numbers select only the current step's own buttons; "2" typed as an answer must not mean "Start over".
 const picked=matchChoice(choices,{text,choiceId:input.choiceId})||matchChoice([START_OVER,ASK_AI,REQUEST_CALL,TALK_TO_TEAM],{text,choiceId:input.choiceId},false);
 const display=picked?.label||text;

 // A greeting in reply to a service template starts that service; otherwise it (re)opens the menu.
 const greetsPreferred=!picked&&Boolean(state.preferredFlow)&&state.status==="menu"&&/^(hi|hello|hey)[.! ]*$/i.test(text);
 if(picked?.id===START_OVER.id||(!picked&&RESTART.test(text)&&!greetsPreferred))return{state:initialBotState(),reply:menuReply(),event:{type:"none"},display};
 /* "Request a call": a signed-in customer gets PawSpace's governed callback (the AI calls them); a visitor
  * leaves a name and number first, as a lead the team calls back. */
 if(picked?.id===REQUEST_CALL.id){
  if(input.signedIn)return{state:{...state,status:"done"},reply:{text:"I'm arranging a call from PawSpace to your registered number now.",choices:[START_OVER],inputHint:"Type a message"},event:{type:"call"},display};
  const steps=stepsFor(TEAM_FLOW,false);
  return{state:{version:1,status:"collecting",flow:TEAM_FLOW.code,step:1,answers:{topic:"Requested a call back"}},reply:askReply(steps[1],"Happy to call you. "),event:{type:"none"},display};
 }
 const escalation=picked?.id===TALK_TO_TEAM.id?"customer_requested_human" as const:!picked&&text?HUMAN_PATTERNS.find(([pattern])=>pattern.test(text))?.[1]:undefined;
 if(escalation&&state.flow!==TEAM_FLOW.code){
  // A signed-in customer is handed over at once: the team already knows who they are and replies here.
  if(input.signedIn)return{state:{...state,status:"done"},reply:{text:"I'm bringing in a PawSpace team member. They will reply to you here.",choices:[],inputHint:"Message the PawSpace team"},event:{type:"human",reason:escalation},display};
  const steps=stepsFor(TEAM_FLOW,false),answers:Record<string,string>=!picked&&text?{topic:text}:{};
  const step=answers.topic?1:0;
  return{state:{version:1,status:"collecting",flow:TEAM_FLOW.code,step,answers},reply:askReply(steps[step],"I'll connect you with our team. "),event:{type:"none"},display};
 }

 if(state.status!=="collecting"){
  // A question does not forget the service a lead came in for: "Yes" afterwards still starts it.
  const keep:BotState={...initialBotState(),...(state.preferredFlow?{preferredFlow:state.preferredFlow}:{})};
  if(picked?.id===ASK_AI.id)return{state:keep,reply:{text:"Sure - type your question and I'll answer it.",choices:[],inputHint:"Type your question"},event:{type:"none"},display};
  /* A lead who came in for a service: their first short reply ("Yes", "Book now", the template's
   * button) starts that service's questions straight away, as the WATI template flow does. */
  const preferred=!picked&&state.preferredFlow&&(SHORT_YES.test(text)||greetsPreferred||flowFromText(text)?.code===state.preferredFlow)?flowByCode(state.preferredFlow):null;
  const flow=picked?flowByCode(picked.id):preferred||(!picked?flowFromText(text):null);
  if(flow){const steps=stepsFor(flow,input.signedIn);return{state:{version:1,status:"collecting",flow:flow.code,step:0,answers:{}},reply:askReply(steps[0],`Great, let's get your ${flow.service} details. `),event:{type:"none"},display};}
  if(!text)return{state:initialBotState(),reply:menuReply(),event:{type:"none"},display};
  // A free question at the menu goes to PawSpace AI; the route answers it and offers the menu again.
  return{state:keep,reply:menuReply("Anything else? Pick a service or ask another question."),event:{type:"ai",question:text},display};
 }

 const flow=flowByCode(state.flow)!,steps=stepsFor(flow,input.signedIn),step=steps[state.step];
 if(!step)return{state:initialBotState(),reply:menuReply(),event:{type:"none"},display};
 let value:string;
 if(step.kind==="choice"){if(!picked||!step.choices?.some(item=>item.id===picked.id))return{state,reply:askReply(step,"Please pick one of the options. "),event:{type:"none"},display};value=picked.label;}
 else{const checked=validate(step,text);if("error"in checked)return{state,reply:askReply(step,`${checked.error} `),event:{type:"none"},display};value=checked.value;}
 state.answers[step.key]=value;state.step+=1;
 const next=steps[state.step];
 if(next)return{state,reply:askReply(next,step.key==="name"?`Thanks ${value.split(" ")[0]}! `:""),event:{type:"none"},display};
 const summary=botSummary(flow,state.answers,input.signedIn);
 /* A signed-in customer's enquiry goes straight to PawSpace AI to recommend, price and book; a visitor's
  * becomes a lead for the team (booking needs a verified account). */
 const closing=input.signedIn&&flow.code!==TEAM_FLOW.code?"Let me check the best option and price for you now.":"A PawSpace team member will get in touch with you shortly.";
 return{state:{...state,status:"done"},reply:{text:`Thank you! Here is what I've noted:\n${summary}\n\n${closing}`,choices:[START_OVER],inputHint:"Type a message"},event:{type:"completed",flow:flow.code,service:flow.service,answers:state.answers,summary},display};
}

/** The question the customer is currently on, re-asked (the stalled-chat nudge uses it). */
export function currentStepReply(state:BotState,signedIn:boolean,prefix=""):BotReply|null{
 if(state.status!=="collecting")return null;const flow=flowByCode(state.flow);if(!flow)return null;
 const step=stepsFor(flow,signedIn)[state.step];return step?askReply(step,prefix):null;
}
/** The enquiry so far, for a lead created before the flow is finished. */
export function partialSummary(state:BotState,signedIn:boolean){const flow=flowByCode(state.flow);return flow?botSummary(flow,state.answers,signedIn):"";}
