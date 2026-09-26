"use client";
import {FormEvent,ReactNode,useEffect,useRef} from "react";
import styles from "./wati-chat.module.css";

export type WatiChoice={id:string;label:string};
export type WatiMessage={id:string;side:"customer"|"pawspace"|"system";author?:string|null;text:string;at?:number|null;team?:boolean;choices?:WatiChoice[]};

/* PawSpace's own pay link ("Pay securely here to confirm it: /v2/booking?bookingId=...") is the only text
 * made clickable, and only on PawSpace's side, so no reply can put an arbitrary link in front of a customer. */
const PAY_LINK=/(\/v2\/booking\?bookingId=[A-Za-z0-9_-]+)/;
function withPayLink(text:string):ReactNode{const parts=text.split(PAY_LINK);return parts.length===1?text:parts.map((part,index)=>index%2?<a key={index} href={part}>Pay now</a>:part);}
const time=(at?:number|null)=>at?new Date(at).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"}):"";

/**
 * The WATI conversation pane, customer side: header with who is answering, the conversation with bot
 * button tiles under the latest bot message, and the composer. Presentation only - the page owns state.
 */
export default function WatiConversation(props:{
 name:string;presence:string;status:string;avatarSrc:string;intro?:ReactNode;
 messages:WatiMessage[];busy:boolean;error?:string;
 draft:string;onDraft:(value:string)=>void;onSend:(text:string)=>void;onChoice:(choice:WatiChoice)=>void;
 placeholder:string;composerDisabled?:boolean;
}){
 const end=useRef<HTMLDivElement|null>(null);
 useEffect(()=>{end.current?.scrollIntoView({behavior:"smooth",block:"end"});},[props.messages.length,props.busy]);
 const last=props.messages.at(-1);
 function submit(event:FormEvent){event.preventDefault();const value=props.draft.trim();if(value&&!props.busy&&!props.composerDisabled)props.onSend(value);}
 return <section className={styles.pane} aria-label="Conversation with PawSpace">
  <header className={styles.head}>
   <div className={styles.person}><img className={styles.avatar} src={props.avatarSrc} alt=""/><div><strong>{props.name}</strong><small><span className={styles.dot} aria-hidden="true"/>{props.presence}</small></div></div>
   <span className={styles.status}>{props.status}</span>
  </header>
  <div className={styles.canvas} aria-live="polite">
   {props.intro}
   {props.messages.map(message=>message.side==="system"
    ?<p key={message.id} className={styles.divider}>{message.text}</p>
    :<div key={message.id} className={`${styles.row} ${message.side==="customer"?styles.rowCustomer:styles.rowPawSpace}`}>
     <article className={`${styles.bubble} ${message.side==="customer"?styles.bubbleCustomer:styles.bubblePawSpace} ${message.team?styles.bubbleTeam:""}`}>
      {message.side==="pawspace"&&message.author&&<span className={styles.author}>{message.author}</span>}
      <p>{message.side==="pawspace"?withPayLink(message.text):message.text}</p>
      {message.at?<span className={styles.meta}>{time(message.at)}{message.side==="customer"?" ✓✓":""}</span>:null}
     </article>
     {message===last&&message.choices?.length?<div className={styles.choices} role="group" aria-label="Choose an option">{message.choices.map(choice=><button key={choice.id} type="button" className={styles.choice} disabled={props.busy} onClick={()=>props.onChoice(choice)}>{choice.label}</button>)}</div>:null}
    </div>)}
   {props.busy&&<div className={`${styles.row} ${styles.rowPawSpace}`} role="status" aria-label="PawSpace is typing"><div className={`${styles.bubble} ${styles.typing}`}><span/><span/><span/></div></div>}
   {props.error&&<p role="alert" className={styles.error}>{props.error}</p>}
   <div ref={end}/>
  </div>
  <form className={styles.composer} onSubmit={submit}>
   <label htmlFor="v2-chat-message" className="sr-only" style={{position:"absolute",width:1,height:1,overflow:"hidden",clip:"rect(0 0 0 0)"}}>Your message</label>
   <textarea id="v2-chat-message" className={styles.input} rows={1} maxLength={4000} value={props.draft} placeholder={props.placeholder} disabled={props.busy||props.composerDisabled} onChange={event=>props.onDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}/>
   <button data-v2-action className={styles.send} disabled={props.busy||props.composerDisabled||!props.draft.trim()}>Send</button>
  </form>
 </section>;
}
