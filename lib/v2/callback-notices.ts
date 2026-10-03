type Message={id:string;createdAt:number};
type Transcript<M extends Message>={threadId:string|null;messages:M[]};
export type LocalCallbackNotice<M extends Message>={threadId:string|null;message:M};

/** Keep response notices through server polling without adding them to another conversation. */
export function withCallbackNotices<M extends Message,T extends Transcript<M>>(transcript:T,notices:readonly LocalCallbackNotice<M>[]):T{
 const ids=new Set(transcript.messages.map(message=>message.id));
 const local=notices.filter(notice=>notice.threadId===transcript.threadId&&!ids.has(notice.message.id)).map(notice=>notice.message);
 if(!local.length)return transcript;
 return{...transcript,messages:[...transcript.messages,...local].sort((a,b)=>a.createdAt-b.createdAt)};
}
