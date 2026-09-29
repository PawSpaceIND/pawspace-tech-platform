"use client";
import {useEffect,useRef,type ReactNode} from "react";

/** Reveal a completed payout action's existing notice without changing its request or result. */
export default function PayoutActionFeedback({notice,children}:{notice:string;children:ReactNode}) {
  const feedback=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    // Initial reads and transient loading errors must not steal the operator's focus.
    if(!notice||!feedback.current)return;
    feedback.current.focus({preventScroll:true});
    feedback.current.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});
  },[notice]);
  return <div ref={feedback} tabIndex={-1} role="group" aria-label="Payout action outcome">{children}</div>;
}
