"use client";
import {useEffect,useRef,useState} from 'react';
import {loadTrainingBroadcastOffers,respondToTrainingBroadcast,type TrainingBroadcastOffer} from '../../lib/training-session-client';
import {formatIndiaDateTimeMedium} from '../../lib/india-time';

export default function TrainingBroadcastInbox({providerId,onAward}:{providerId:string;onAward:(sessionId:string)=>Promise<void>}) {
 const [offers,setOffers]=useState<TrainingBroadcastOffer[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[clock,setClock]=useState(()=>Date.now());
 const generation=useRef(0),keys=useRef(new Map<string,string>());
 async function refresh(){const current=++generation.current;try{const rows=await loadTrainingBroadcastOffers(providerId);if(current===generation.current){setOffers(rows);setError('');}}catch(problem){if(current===generation.current)setError(problem instanceof Error?problem.message:'Unable to load offers');}}
 useEffect(()=>{let active=true;queueMicrotask(()=>{if(active)void refresh();});const timer=window.setInterval(()=>{setClock(Date.now());void refresh();},30000);const clockTimer=window.setInterval(()=>setClock(Date.now()),1000);return()=>{active=false;generation.current++;window.clearInterval(timer);window.clearInterval(clockTimer);};},[providerId]);
 async function respond(offer:TrainingBroadcastOffer,action:'accept'|'decline'){
  const fingerprint=[offer.bookingId,offer.sessionId,offer.providerId,offer.expiresAt,action].join(':');
  let idempotencyKey=keys.current.get(fingerprint);if(!idempotencyKey){idempotencyKey=`training-broadcast:${crypto.randomUUID()}`;keys.current.set(fingerprint,idempotencyKey);}
  setBusy(true);setError('');try{await respondToTrainingBroadcast({...offer,action,idempotencyKey,...(action==='decline'?{reason:'Trainer unavailable for this appointment'}:{})});await refresh();if(action==='accept')await onAward(offer.sessionId);}catch(problem){setError(problem instanceof Error?problem.message:'Unable to respond to this offer');}finally{setBusy(false);}
 }
 return <section aria-label="Training offers"><h2>Training offers</h2><p>Accept an available appointment to become its assigned trainer. The first valid acceptance wins.</p><button disabled={busy} onClick={()=>void refresh()}>Refresh offers</button>{error&&<p role="alert">{error}</p>}{offers.length===0&&<p>No open offers.</p>}{offers.map(offer=><article key={offer.bookingId}><h3>{offer.packageName}</h3><p>{offer.zoneId} · {formatIndiaDateTimeMedium(offer.scheduledStart)}</p><p>Respond before {formatIndiaDateTimeMedium(new Date(offer.expiresAt).toISOString())}.</p><button disabled={busy||clock>=offer.expiresAt} onClick={()=>void respond(offer,'accept')}>Accept offer</button><button disabled={busy||clock>=offer.expiresAt} onClick={()=>void respond(offer,'decline')}>Decline offer</button></article>)}</section>;
}
