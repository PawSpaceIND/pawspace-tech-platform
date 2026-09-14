"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {boundedFetch} from "../../lib/bounded-fetch";
import {deliverStatus,enqueueStatus,readStatusQueue,saveStatusQueue,withStatusQueueLock,type QueuedStatus} from "../../lib/partner-status-queue";
export function useStatusQueue(provider:string|undefined,onSynced:()=>void) {
  const [connection,setConnection]=useState<"Online"|"Reconnecting"|"Offline">("Reconnecting");
  const [pending,setPending]=useState<QueuedStatus[]>([]),[error,setError]=useState("");
  const lock=useRef(false),generation=useRef(0),synced=useRef(onSynced);useEffect(()=>{synced.current=onSynced;},[onSynced]);
  const flush=useCallback(async()=>{
    if(!provider||lock.current)return;
    const epoch=generation.current;
    lock.current=true;
    try{
      await withStatusQueueLock(provider,"delivery",async()=>{
      let items=readStatusQueue(provider);setPending(items);
      if(!navigator.onLine){setConnection("Offline");return;}
      if(items.length)setConnection("Reconnecting");
      for(const item of items){
        if(epoch!==generation.current)return;
        if(item.error)continue;
        try{await deliverStatus(item);}catch(problem){
          if(epoch!==generation.current)return;
          const failure=problem as Error&{retry?:boolean};
          if(failure instanceof TypeError||failure.name==="AbortError"||failure.retry){setConnection(navigator.onLine?"Reconnecting":"Offline");return;}
          await withStatusQueueLock(provider,"storage",()=>{items=readStatusQueue(provider).map(value=>value.id===item.id?{...value,error:failure.message}:value);saveStatusQueue(provider,items);});setPending(items);continue;
        }
        if(epoch!==generation.current)return;
        await withStatusQueueLock(provider,"storage",()=>{items=readStatusQueue(provider).filter(value=>value.id!==item.id);saveStatusQueue(provider,items);});setPending(items);synced.current();
      }
      // Verify a session response even when no job/heartbeat is running.
      try{const response=await boundedFetch("/api/identity-session",{cache:"no-store"});if(epoch===generation.current)setConnection(response.ok?"Online":"Reconnecting");}catch{if(epoch===generation.current)setConnection(navigator.onLine?"Reconnecting":"Offline");}
      });
    }catch(problem){setError(problem instanceof Error?problem.message:"Unable to save updates");}finally{lock.current=false;}
  },[provider]);
  useEffect(()=>{const epoch=++generation.current;queueMicrotask(()=>{if(epoch===generation.current){setPending([]);setError("");void flush();}});const offline=()=>setConnection("Offline");const timer=setInterval(()=>void flush(),15000);window.addEventListener("online",flush);window.addEventListener("offline",offline);return()=>{generation.current=epoch+1;clearInterval(timer);window.removeEventListener("online",flush);window.removeEventListener("offline",offline);};},[flush]);
  const queue=async(input:Omit<QueuedStatus,"id"|"createdAt"|"providerId">)=>{if(!provider)throw new Error("Sign in before updating a job");await withStatusQueueLock(provider,"storage",()=>enqueueStatus({...input,providerId:provider}));setPending(readStatusQueue(provider));await flush();};
  const retry=async()=>{if(!provider)return;try{await withStatusQueueLock(provider,"storage",()=>{const items=readStatusQueue(provider).map(item=>({...item,error:undefined}));saveStatusQueue(provider,items);});setError("");await flush();}catch(problem){setError(problem instanceof Error?problem.message:"Unable to retry saved updates");}};
  return{connection,setConnection,pending,error,queue,retry};
}
