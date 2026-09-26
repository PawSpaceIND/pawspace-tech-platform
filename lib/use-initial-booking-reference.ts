"use client";
import {useEffect,useState} from 'react';
/** Hydrate once: writing the new receipt URL must not unmount an in-flight care/payment save. */
export function useInitialBookingReference(){
 const [reference,setReference]=useState('');
 useEffect(()=>{let active=true;const initial=new URLSearchParams(window.location.search).get('bookingId')||'';queueMicrotask(()=>{if(active)setReference(initial);});return()=>{active=false;};},[]);
 return reference;
}
