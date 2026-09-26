/**
 * Partner-facing words for an offer state (lib/provider-offer-state.ts). Pure and client-safe: every
 * partner surface (Partner app, Sitter, Host and Driver workspaces) says the same thing about the same
 * offer, and none of them offers an Accept that the lifecycle would refuse.
 */
export type OfferCopyInput={state?:string;expiresAt?:number|null}|null|undefined;
export type OfferCopy={tone:"open"|"attention"|"done"|"muted";label:string;detail:string};

/** 26 Sep, 3:45 pm IST: offer deadlines are always read in India time. */
export function offerTime(ms:unknown){const value=Number(ms);if(!Number.isFinite(value)||value<=0)return"";return`${new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"numeric",minute:"2-digit"}).format(new Date(value))} IST`;}

export function describeProviderOffer(offer:OfferCopyInput,options:{noun?:string;bucket?:string}={}):OfferCopy{
 const noun=options.noun||"booking",state=String(offer?.state||""),deadline=offerTime(offer?.expiresAt);
 if(options.bucket==="past"&&state!=="closed")return{tone:"muted",label:"Past",detail:`This ${noun}'s time window has ended, so there is nothing to accept or start. Contact PawSpace Operations if anything about it is still open.`};
 if(state==="open")return deadline
  ?{tone:"open",label:`Offer open · accept by ${deadline}`,detail:`Review the details below and accept before ${deadline}. After that the offer expires and PawSpace Operations arranges cover.`}
  :{tone:"open",label:"Waiting for your acceptance",detail:`Review the details below and accept to confirm this ${noun}.`};
 if(state==="expired")return{tone:"attention",label:"Offer expired · Operations arranging cover",detail:`Your acceptance window closed${deadline?` at ${deadline}`:""}. PawSpace Operations is arranging cover, so you do not need to do anything else.`};
 if(state==="withdrawn")return{tone:"attention",label:"With PawSpace Operations",detail:`This ${noun} is no longer waiting on you: Operations is arranging cover or has reassigned it.`};
 if(state==="accepted")return{tone:"done",label:"Accepted",detail:`You have accepted this ${noun}.`};
 if(state==="awaiting_payment")return{tone:"muted",label:"Customer payment pending",detail:"The customer has not paid yet. There is nothing to accept until payment is captured."};
 if(state==="closed")return{tone:"muted",label:"Closed",detail:`This ${noun} is closed.`};
 return{tone:"muted",label:"Status unavailable",detail:"Refresh to load the current offer."};
}

/** Accept renders only for an open offer on a job whose window has not already passed. */
export function acceptAvailable(offer:OfferCopyInput,bucket?:string){return String(offer?.state||"")==="open"&&bucket!=="past";}

/** A job is past once its window has ended, unless the partner is mid-service (they must still finish it). */
export function windowEnded(end:unknown,start?:unknown,now=Date.now()){const at=Date.parse(String(end||""));const fallback=Date.parse(String(start||""));const finished=Number.isFinite(at)?at:Number.isFinite(fallback)?fallback:null;return finished!==null&&finished<now;}
