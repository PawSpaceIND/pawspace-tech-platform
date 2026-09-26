"use client";
import {useEffect,useState} from 'react';
import ServiceFeedbackCard,{type PendingFeedback} from './service-feedback-card';
export default function BookingServiceFeedback({bookingId,completed}:{bookingId:string;completed:boolean}){
 const[request,setRequest]=useState<PendingFeedback|null>(null),[customerId,setCustomerId]=useState(''),[error,setError]=useState(''),[done,setDone]=useState('');
 useEffect(()=>{if(!completed)return;const controller=new AbortController();void Promise.all([fetch('/api/identity-session',{cache:'no-store',signal:controller.signal}).then(r=>r.json()),fetch('/api/service-review',{cache:'no-store',signal:controller.signal}).then(async r=>{const b=await r.json();if(!r.ok)throw new Error(b.error||'Unable to load your feedback request.');return b;})]).then(([identity,feedback])=>{if(controller.signal.aborted)return;if(identity.data?.subjectType!=='customer')throw new Error('Sign in to your customer account.');setCustomerId(identity.data.subjectId);setRequest((feedback.data?.pending||[]).find((item:PendingFeedback)=>item.bookingId===bookingId)||null);setError('');}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Feedback is unavailable.');});return()=>controller.abort();},[bookingId,completed]);
 if(!completed)return null;
 if(request?.bookingId===bookingId&&customerId)return <section aria-label="Completed service feedback"><ServiceFeedbackCard key={request.requestId} item={request} customerId={customerId} onDone={(_,message)=>setDone(message)}/>{done&&<p role="status">{done}</p>}</section>;
 return <section aria-label="Completed service feedback"><h3>Service feedback</h3><p role={error?'alert':undefined}>{error||'No pending feedback request is available for this booking. Existing feedback is not resubmitted.'}</p></section>;
}
