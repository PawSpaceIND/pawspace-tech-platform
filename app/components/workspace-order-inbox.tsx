'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import type {WorkspaceOrderCursor,WorkspaceOrderUpdate} from '../../lib/workspace-order-updates';
import styles from './workspace-order-inbox.module.css';
type Feed={owner:string;audience:'staff'|'provider';items:WorkspaceOrderUpdate[];unread:number;nextCursor:WorkspaceOrderCursor|null;sourceStatus:Record<string,string>};
export default function WorkspaceOrderInbox(){
 const [feed,setFeed]=useState<Feed|null>(null),[error,setError]=useState(''),[denied,setDenied]=useState(false),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[cursor,setCursor]=useState<WorkspaceOrderCursor|null>(null),[retry,setRetry]=useState(0);
 const dialog=useRef<HTMLDialogElement>(null),button=useRef<HTMLButtonElement>(null),owner=useRef(''),seen=useRef(new Set<string>()),epoch=useRef(0);
 useEffect(()=>{let active=true,inFlight=false;const controller=new AbortController();const version=++epoch.current;
  const get=async(before:WorkspaceOrderCursor|null)=>{const response=await fetch('/api/workspace-order-updates'+(before?'?cursor='+encodeURIComponent(JSON.stringify(before)):''),{cache:'no-store',signal:controller.signal});if(!response.ok)throw Object.assign(new Error('Order updates unavailable'),{status:response.status});return (await response.json()).data as Feed;};
  const load=async()=>{if(inFlight||document.visibilityState==='hidden')return;if(!navigator.onLine){setError('Offline · displayed updates may be out of date. Reconnecting automatically.');return;}inFlight=true;
   try{const latest=await get(null);if(!active||epoch.current!==version)return;const changed=owner.current!==latest.owner;if(changed){owner.current=latest.owner;seen.current.clear();setCursor(null);setNotice('');}
    const fresh=changed?[]:latest.items.filter(i=>i.readAt==null&&!seen.current.has(i.id));for(const item of latest.items)seen.current.add(item.id);
    let visible=latest;if(cursor&&!changed)visible=await get(cursor);if(!active||epoch.current!==version||visible.owner!==owner.current)return;
    setFeed({...visible,unread:latest.unread});setDenied(false);setError('');if(fresh.length)setNotice(`${fresh.length} new order ${fresh.length===1?'update':'updates'}. Open your inbox to review.`);
   }catch(e){if(!active||epoch.current!==version)return;const status=(e as {status?:number}).status;if(status===401||status===403){owner.current='';seen.current.clear();setFeed(null);setDenied(true);setNotice('');dialog.current?.close();}else setError('Order updates unavailable · shown information may be out of date. Retrying automatically.');}finally{inFlight=false;}};
  const identity=()=>{epoch.current++;controller.abort();owner.current='';seen.current.clear();setFeed(null);setNotice('');setCursor(null);dialog.current?.close();setRetry(n=>n+1);};
  const resume=()=>void load();void load();const timer=setInterval(resume,15000);window.addEventListener('online',resume);window.addEventListener('focus',resume);window.addEventListener('pawspace:identity-changed',identity);document.addEventListener('visibilitychange',resume);
  return()=>{active=false;controller.abort();clearInterval(timer);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);window.removeEventListener('pawspace:identity-changed',identity);document.removeEventListener('visibilitychange',resume);};
 },[cursor,retry]);
 async function read(item:WorkspaceOrderUpdate){if(item.readAt!=null||!owner.current)return;const requestOwner=owner.current,version=epoch.current;setBusy(true);try{const response=await fetch('/api/workspace-order-updates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({eventId:item.id})});if(!response.ok)throw new Error();if(owner.current!==requestOwner||epoch.current!==version)return;setRetry(n=>n+1);setNotice('');}catch{if(owner.current===requestOwner&&epoch.current===version)setError('Could not mark the update read. It may no longer be in your scope; refresh and retry.');}finally{setBusy(false);}}
 if(denied)return null;
 return <div className={styles.host}><button ref={button} type="button" style={{minHeight:48}} aria-label={`Order inbox${feed?.unread?` · ${feed.unread} unread`:''}`} onClick={()=>dialog.current?.showModal()}>♢ Order inbox {Boolean(feed?.unread)&&<b>{feed!.unread}</b>}</button><span className={styles.notice} role="status" aria-live="polite">{notice}</span>
 <dialog ref={dialog} className={styles.dialog} aria-labelledby="workspace-order-inbox-title" onClose={()=>button.current?.focus()}><header><h2 id="workspace-order-inbox-title">Order inbox</h2><button type="button" aria-label="Close order inbox" onClick={()=>dialog.current?.close()}>×</button></header><p>{feed?`${feed.unread} unread · ${feed.audience==='provider'?'your assigned jobs':'your authorized booking scope'}`:'Loading authorized updates…'}</p><small>Checks every 15 seconds while this page is visible. Confirmation is separate from payment capture.</small>
 {error&&<p role="alert">{error} <button type="button" onClick={()=>setRetry(n=>n+1)}>Retry updates</button></p>}
 {feed?.sourceStatus.food==='unavailable'&&<p>Food order updates are unavailable.</p>}
 {feed?.items.map(item=><article key={item.id}><h3>{item.title}</h3><p>{item.serviceCode.replaceAll('_',' ')} · {item.recordId}</p><small>{item.readAt!=null?'Read':'Unread'}</small><div><button type="button" disabled={busy||Boolean(error)||item.readAt!=null} onClick={()=>void read(item)}>{item.readAt!=null?'Read':'Mark read'}</button><Link href={feed.audience==='provider'?'/partner/jobs':'/booking-command-center'}>Open workspace →</Link></div></article>)}
 {feed&&!feed.items.length&&!error&&<p>No order updates are available in your current scope.</p>}
 <nav><button type="button" disabled={!cursor} onClick={()=>setCursor(null)}>Latest updates</button><button type="button" disabled={!feed?.nextCursor} onClick={()=>setCursor(feed?.nextCursor??null)}>Older updates</button></nav></dialog></div>;
}
