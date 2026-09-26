"use client";
import Link from "next/link";
import {useCallback,useEffect,useRef,useState} from "react";
import WatiConversation,{type WatiChoice,type WatiMessage} from "../../components/wati-chat/WatiConversation";
import styles from "./page.module.css";

/*
 * PawSpace web chat, WATI-style: the bot opens with service buttons and a short questionnaire, PawSpace
 * AI answers questions and sells, and a person takes over from the Inbox & AI workspace when needed.
 * The conversation pane is the Inbox's WATI chat pane, customer side (app/components/wati-chat).
 */
type Identity="checking"|"customer"|"guest"|"unavailable";
type BotReply={text:string;choices:WatiChoice[];inputHint:string|null};
type PublicTurn={data?:{bot?:BotReply;display?:string;ai?:{turn?:{output?:string}}|null;lead?:{captured?:boolean}|null};error?:string};
type ThreadMessage={id:string;role:"customer"|"ai"|"bot"|"team";text:string;createdAt:number;author:string|null;choices?:WatiChoice[];inputHint?:string|null};
type Transcript={threadId:string|null;messages:ThreadMessage[];handoff:{active:boolean;status:"queued"|"staff_active"|null}};

/* The server bounds a chat turn to 15 s (#1081); the page allows for network and the rest of the turn. */
const REPLY_TIMEOUT_MS=30000;
/* While a person has the conversation their replies arrive on their own, so look for them often. */
const TEAM_POLL_MS=4000,IDLE_POLL_MS=20000;
const AVATAR="/assets/pawspace-icon.jpeg";
/* WATI's service menu card: the doorstep banner, and each service with its own art. */
const MENU_BANNER="/assets/pawspace-doorstep.png";
const SERVICE_ART:Record<string,string>={grooming:"/assets/pawspace-grooming-cartoon.webp",training:"/assets/pawspace-training-cartoon.webp",boarding:"/assets/pawspace-boarding-cartoon.webp",pet_sitting:"/assets/pawspace-sitting-cartoon.webp",dog_walking:"/assets/pawspace-walking-cartoon.webp",pet_taxi:"/assets/pawspace-taxi-cartoon.webp",fresh_food:"/assets/pawspace-food-cartoon.webp",relocation:"/assets/pawspace-relocation-cartoon.webp"};
const cleanAiText=(value:string)=>value.replace(/\*\*/g,"").trim();
let sequence=0;const localId=()=>`local-${++sequence}`;

export default function V2Chat(){
 const[mode,setMode]=useState<"public"|"authenticated">("public"),[identity,setIdentity]=useState<Identity>("checking"),[draft,setDraft]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const[publicSessionKey]=useState(()=>crypto.randomUUID().replace(/-/g,"")),[publicMessages,setPublicMessages]=useState<WatiMessage[]>([]),[publicHint,setPublicHint]=useState<string|null>(null);
 const[transcript,setTranscript]=useState<Transcript|null>(null);
 const pending=useRef<{text:string;choiceId:string|null;mode:string;key:string}|null>(null);
 useEffect(()=>{let active=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);fetch("/api/identity-session",{cache:"no-store",signal:controller.signal}).then(async r=>{if(r.status===401){if(active)setIdentity("guest");return;}if(!r.ok)throw new Error("Session unavailable");const b=await r.json();if(active)setIdentity(b.data?.subjectType==="customer"?"customer":"guest");}).catch(()=>{if(active)setIdentity("unavailable");}).finally(()=>clearTimeout(timer));return()=>{active=false;controller.abort();clearTimeout(timer);};},[]);

 async function post(body:Record<string,unknown>){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),REPLY_TIMEOUT_MS);
  try{const r=await fetch("/api/ai-web-chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:controller.signal});const payload=await r.json().catch(()=>null);if(!r.ok){if(r.status===401)setIdentity("guest");throw new Error(payload?.error||"Chat is temporarily unavailable.");}return payload;}
  catch(cause){throw controller.signal.aborted?new Error("The reply is taking too long. Send the same message again and we will show the reply as soon as it is ready."):cause;}
  finally{clearTimeout(timer);}
 }

 /* Ask PawSpace AI (not signed in): the bot greets with the service buttons as soon as the page opens. */
 const startPublic=useCallback(async()=>{try{const payload=await post({mode:"public",bot:true,start:true,sessionKey:publicSessionKey}) as PublicTurn;const bot=payload.data?.bot;if(bot){setPublicMessages([{id:localId(),side:"system",text:"PawSpace bot started"},{id:localId(),side:"pawspace",author:"PawSpace bot",text:bot.text,choices:bot.choices,at:Date.now()}]);setPublicHint(bot.inputHint);}}catch(cause){setError(cause instanceof Error?cause.message:"Chat is temporarily unavailable.");}
 },[publicSessionKey]);
 /* Greeted once per visit: switching back from My PawSpace shows the same conversation, in step with the
  * bot state the server holds for this session, instead of starting it again. */
 const publicStarted=useRef(false);
 useEffect(()=>{if(mode!=="public"||publicStarted.current)return;publicStarted.current=true;const greet=()=>{void startPublic();};greet();},[mode,startPublic]);

 /* My PawSpace reads the conversation back from the server, so replies from the PawSpace team appear here
  * and nothing is lost on reload. */
 const loadTranscript=useCallback(async(signal?:AbortSignal)=>{const r=await fetch("/api/ai-web-chat?mode=thread",{cache:"no-store",signal});if(r.status===401){setIdentity("guest");return null;}if(!r.ok)return null;const payload=await r.json().catch(()=>null) as {data?:Transcript}|null;if(payload?.data)setTranscript(payload.data);return payload?.data||null;},[]);
 const withTeam=Boolean(transcript?.handoff.active);
 useEffect(()=>{if(mode!=="authenticated"||identity!=="customer")return;let active=true;const controller=new AbortController();
  /* One request opens the chat: start is a no-op for a conversation that already exists, and it returns
   * the conversation either way. */
  const open=()=>{void post({mode:"authenticated",bot:true,start:true}).then(async payload=>{const data=(payload as {data?:{transcript?:Transcript|null}}|null)?.data?.transcript;if(!active)return;if(data)setTranscript(data);else await loadTranscript(controller.signal);}).catch(()=>{if(active)void loadTranscript(controller.signal).catch(()=>{});});};open();
  const timer=setInterval(()=>{if(active&&document.visibilityState==="visible")void loadTranscript(controller.signal).catch(()=>{});},withTeam?TEAM_POLL_MS:IDLE_POLL_MS);
  return()=>{active=false;controller.abort();clearInterval(timer);};
 },[mode,identity,withTeam,loadTranscript]);

 function choose(next:"public"|"authenticated"){setMode(next);setError("");setDraft("");pending.current=null;}

 async function send(text:string,choice?:WatiChoice){
  if(busy||(mode==="authenticated"&&identity!=="customer"))return;
  const shown=choice?.label||text,choiceId=choice?.id||null;
  if(!pending.current||pending.current.text!==shown||pending.current.mode!==mode||pending.current.choiceId!==choiceId)pending.current={text:shown,choiceId,mode,key:crypto.randomUUID()};
  setBusy(true);setError("");
  try{
   if(mode==="public"){
    setPublicMessages(current=>[...current,{id:localId(),side:"customer",text:shown,at:Date.now()}]);
    const history=publicMessages.filter(item=>item.side==="customer").map(item=>({role:"user" as const,text:item.text})).slice(-8);
    const payload=await post({mode,bot:true,message:choice?"":text,choiceId,sessionKey:publicSessionKey,history}) as PublicTurn;
    const data=payload.data,next:WatiMessage[]=[];
    const answer=data?.ai?.turn?.output;if(answer)next.push({id:localId(),side:"pawspace",author:"PawSpace AI",text:cleanAiText(answer),at:Date.now()});
    if(data?.bot)next.push({id:localId(),side:"pawspace",author:"PawSpace bot",text:data.bot.text,choices:data.bot.choices,at:Date.now()});
    if(data?.lead?.captured)next.push({id:localId(),side:"system",text:"Your details were shared with the PawSpace team"});
    setPublicMessages(current=>[...current,...next]);setPublicHint(data?.bot?.inputHint||null);
   }else{
    // The customer's message shows at once; the server's answer replaces the conversation with the stored one.
    const sentAt=Date.now();setTranscript(current=>current?{...current,messages:[...current.messages,{id:`pending-${sentAt}`,role:"customer",text:shown,createdAt:sentAt} as Transcript["messages"][number]]}:current);
    const payload=await post({mode,bot:true,message:choice?"":text,choiceId,idempotencyKey:"v2-web-"+pending.current.key}) as {data?:{transcript?:Transcript|null}}|null;
    if(payload?.data?.transcript)setTranscript(payload.data.transcript);else await loadTranscript();
   }
   setDraft("");pending.current=null;
  }catch(cause){setError(cause instanceof Error?cause.message:"Chat is temporarily unavailable.");if(mode==="authenticated")void loadTranscript().catch(()=>{});}
  finally{setBusy(false);}
 }

 const authenticatedReady=mode==="authenticated"&&identity==="customer";
 const threadMessages:WatiMessage[]=authenticatedReady?(transcript?.messages||[]).flatMap((item,index,all)=>{
  const message:WatiMessage={id:item.id,side:item.role==="customer"?"customer":"pawspace",author:item.role==="team"?"PawSpace team":item.role==="bot"?"PawSpace bot":item.role==="ai"?"PawSpace AI":null,text:item.role==="ai"?cleanAiText(item.text):item.text,at:item.createdAt,team:item.role==="team",choices:item.choices};
  const joined=item.role==="team"&&all.slice(0,index).every(prior=>prior.role!=="team");
  return joined?[{id:`${item.id}-joined`,side:"system",text:"Chat is now with the PawSpace team"},message]:[message];
 }):[];
 const lastThread=transcript?.messages.at(-1);
 const messages=mode==="public"?publicMessages:threadMessages;
 const presence=mode==="public"?"PawSpace bot · PawSpace AI":withTeam?(transcript?.handoff.status==="staff_active"?"PawSpace team · Available":"Connecting you to the PawSpace team"):"PawSpace bot · Account-aware";
 const placeholder=mode==="public"?publicHint||"Ask PawSpace AI":withTeam?"Message the PawSpace team":lastThread?.role==="bot"&&lastThread.inputHint?lastThread.inputHint:"Type your message";

 return <main className={styles.page} data-identity={identity} data-v2-chat="true">
  <div className={styles.chatShell}>
   <div className={styles.modeBar} aria-label="Chat topic"><button aria-pressed={mode==="public"} disabled={busy} onClick={()=>choose("public")}>Ask PawSpace AI</button><button aria-pressed={mode==="authenticated"} disabled={busy} onClick={()=>choose("authenticated")}>My PawSpace</button><Link href="/v2" className={styles.back}>Home</Link></div>
   {mode==="authenticated"&&identity!=="customer"?<section className={styles.notice} role="status"><h1>Ask PawSpace anything.</h1>{identity==="checking"?<p>Checking your PawSpace sign-in...</p>:identity==="unavailable"?<><p>We could not check your sign-in.</p><button onClick={()=>window.location.reload()}>Check again</button></>:<><p>Sign in from the V2 home to discuss bookings and account details.</p><Link href="/v2">Open V2 home</Link></>}</section>
   :<WatiConversation name="PawSpace" presence={presence} status={withTeam&&authenticatedReady?"With our team":"Open"} avatarSrc={AVATAR} serviceArt={SERVICE_ART} menuBanner={MENU_BANNER}
     intro={<h1 className={styles.watiIntro}>Ask PawSpace anything.</h1>}
     messages={messages} busy={busy} error={error} draft={draft} onDraft={setDraft}
     onSend={text=>void send(text)} onChoice={choice=>void send(choice.label,choice)} placeholder={placeholder}/>}
  </div>
  <nav className={styles.dock} aria-label="PawSpace V2 navigation"><Link href="/v2"><strong>Home</strong></Link><Link href="/v2/grooming"><strong>Book</strong></Link><Link href="/v2/chat" className={styles.active}><strong>AI</strong></Link><Link href="/v2/activity"><strong>Activity</strong></Link></nav>
 </main>;
}
