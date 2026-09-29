"use client";
import {useEffect,useRef,type ReactNode} from "react";

/** Reveal a completed, explicit payout attempt's existing outcome without changing its request or result. */
export default function PayoutActionFeedback({requestId,children}:{requestId:number;children:ReactNode}) {
  const feedback=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    // Only an explicit payout completion advances this token, including repeated error-only outcomes.
    if(!requestId||!feedback.current?.textContent?.trim())return;
    feedback.current.focus({preventScroll:true});
    feedback.current.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});
  },[requestId]);
  return <div ref={feedback} tabIndex={-1} role="group" aria-label="Payout action outcome">{children}</div>;
}
