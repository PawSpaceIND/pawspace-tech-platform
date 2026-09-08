"use client";
import { useEffect, useRef, useState } from "react";

type Item={id:string;service_code:string;event_type:string;severity:string;status:string;title:string;body:string;created_at:number};
type Cursor={at:number;id:string};
async function requestJson(url:string,init:RequestInit={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{const response=await fetch(url,{...init,cache:"no-store",signal:controller.signal});if(!response.ok)throw new Error("Request failed");return await response.json();}
 finally{clearTimeout(timer);}
}

export default function OrderNotificationCenter(){
 const[customerId,setCustomerId]=useState(""),[items,setItems]=useState<Item[]>([]),[open,setOpen]=useState(false),[error,setError]=useState(""),[loading,setLoading]=useState(false),[reload,setReload]=useState(0),[unread,setUnread]=useState(0);
 const[cursor,setCursor]=useState<Cursor|null>(null),[nextCursor,setNextCursor]=useState<Cursor|null>(null),[history,setHistory]=useState<Array<Cursor|null>>([]);
 const owner=useRef("");
 useEffect(()=>{
  let active=true,version=0;
  const clear=()=>{owner.current="";setCustomerId("");setItems([]);setUnread(0);setOpen(false);setCursor(null);setNextCursor(null);setHistory([]);setError("");};
  const refresh=async()=>{const attempt=++version;try{const body=await requestJson("/api/identity-session");if(!active||attempt!==version)return;const id=body.data?.subjectType==="customer"?String(body.data.subjectId||""):"";if(id!==owner.current){clear();owner.current=id;setCustomerId(id);}}catch{if(active&&attempt===version)clear();}};
  const changed=()=>{clear();void refresh();};
  const visible=()=>{if(document.visibilityState==="visible")void refresh();};
  const storage=(event:StorageEvent)=>{if(event.key==="pawspace_customer"||event.key===null)changed();};
  void refresh();const timer=setInterval(()=>void refresh(),60000);
  window.addEventListener("pawspace:identity-changed",changed);window.addEventListener("focus",visible);window.addEventListener("storage",storage);document.addEventListener("visibilitychange",visible);
  return()=>{active=false;version++;clearInterval(timer);window.removeEventListener("pawspace:identity-changed",changed);window.removeEventListener("focus",visible);window.removeEventListener("storage",storage);document.removeEventListener("visibilitychange",visible);};
 },[]);
 useEffect(()=>{
  if(!customerId)return;let active=true,inFlight=false;
  const load=async()=>{if(inFlight)return;inFlight=true;setLoading(true);setError("");try{const body=await requestJson(`/api/order-notifications?customerId=${encodeURIComponent(customerId)}&limit=30${cursor?`&cursor=${encodeURIComponent(JSON.stringify(cursor))}`:""}`);if(active&&owner.current===customerId){setItems(body.data?.items??[]);setUnread(Number(body.data?.unread||0));setNextCursor(body.data?.nextCursor??null);}}catch{if(active&&owner.current===customerId)setError("Unable to load order updates. Please retry.");}finally{inFlight=false;if(active)setLoading(false);}};
  void load();const timer=setInterval(()=>void load(),60000);return()=>{active=false;clearInterval(timer)};
 },[customerId,cursor,reload]);
 async function markRead(item:Item){if(item.status==="read")return;const requestOwner=customerId;try{await requestJson("/api/order-notifications",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({customerId,notificationId:item.id,action:"mark_read"})});if(owner.current!==requestOwner)return;setError("");setItems(current=>current.map(value=>value.id===item.id?{...value,status:"read"}:value));setReload(value=>value+1);}catch{if(owner.current===requestOwner)setError("Unable to mark this update as read. Select it again to retry.");}}
 function older(){if(!nextCursor||loading)return;setHistory(previous=>[...previous,cursor]);setCursor(nextCursor);setItems([]);}
 function newer(){if(!history.length||loading)return;setCursor(history[history.length-1]);setHistory(previous=>previous.slice(0,-1));setItems([]);}
 if(!customerId)return null;
 return <div className="ps-order-fab" style={{position:"fixed",right:18,bottom:18,zIndex:80,fontFamily:"inherit"}}>{open&&<section role="dialog" aria-label="PawSpace order notifications" style={{position:"absolute",right:0,bottom:58,width:"min(360px,calc(100vw - 32px))",maxHeight:"65vh",overflow:"auto",background:"var(--ps-surface,#fff)",border:"1px solid var(--ps-border,#e7e1e8)",borderRadius:18,boxShadow:"0 18px 50px rgba(0,0,0,.18)",padding:12}}><header style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 4px 10px"}}><div><b>Order updates</b><small style={{display:"block",opacity:.65}}>{error?"Updates unavailable":loading?"Loading updates…":unread?`${unread} unread`:"You're all caught up"}</small></div><button aria-label="Close notifications" onClick={()=>setOpen(false)} style={{border:0,background:"transparent",fontSize:18}}>×</button></header>{error&&<div role="alert"><p>{error}</p><button onClick={()=>setReload(value=>value+1)}>Retry order updates</button></div>}{loading&&<p role="status">Loading order updates…</p>}{items.length===0&&!error&&!loading?<p style={{fontSize:13,opacity:.7,padding:8}}>New booking, service, cancellation and refund updates will appear here.</p>:items.map(item=><button key={item.id} onClick={()=>void markRead(item)} style={{display:"block",width:"100%",textAlign:"left",border:0,borderTop:"1px solid var(--ps-border,#eee)",background:item.status==="unread"?"rgba(111,72,172,.07)":"transparent",padding:"12px 8px",cursor:"pointer"}}><strong style={{display:"block",fontSize:13}}>{item.title}</strong><span style={{display:"block",fontSize:12,opacity:.75,lineHeight:1.45,marginTop:3}}>{item.body}</span><small style={{display:"block",fontSize:10,opacity:.55,marginTop:6}}>{new Date(item.created_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} IST</small></button> )}{(history.length>0||nextCursor)&&<nav aria-label="Order update pages" style={{display:"flex",justifyContent:"space-between",padding:8}}><button disabled={loading||history.length===0} onClick={newer}>Newer updates</button><button disabled={loading||!nextCursor} onClick={older}>Older updates</button></nav>}</section>}<button aria-label={unread?`${unread} unread order updates`:"Order notifications"} onClick={()=>setOpen(value=>!value)} style={{width:52,height:52,borderRadius:26,border:"1px solid var(--ps-border,#ddd)",background:"var(--ps-surface,#fff)",boxShadow:"0 8px 26px rgba(0,0,0,.14)",fontSize:22,cursor:"pointer",position:"relative"}}>♢{unread>0&&<i style={{position:"absolute",right:-3,top:-3,minWidth:20,height:20,borderRadius:10,background:"#b3261e",color:"white",fontStyle:"normal",fontSize:11,display:"grid",placeItems:"center",padding:"0 3px"}}>{unread>99?"99+":unread}</i>}</button></div>;
}
