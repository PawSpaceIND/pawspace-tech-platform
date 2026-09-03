"use client";

import{useEffect,useState,type ReactNode}from"react";

export default function CustomerExperienceLiveTemplate({children}:{children:ReactNode}){
 const[revision,setRevision]=useState(0);
 useEffect(()=>{
  let active=true;let fallback:ReturnType<typeof setInterval>|undefined;const refresh=()=>{if(active)setRevision(value=>value+1);};
  const startFallback=()=>{if(fallback)return;fallback=setInterval(refresh,5000);};
  if(typeof EventSource==="undefined"){startFallback();return()=>{active=false;if(fallback)clearInterval(fallback);};}
  const source=new EventSource("/api/conversations/stream");source.addEventListener("conversation",refresh);source.onerror=()=>startFallback();
  return()=>{active=false;source.close();if(fallback)clearInterval(fallback);};
 },[]);
 return <div key={revision}>{children}</div>;
}
