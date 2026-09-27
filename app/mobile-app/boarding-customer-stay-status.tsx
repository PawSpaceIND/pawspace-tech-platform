"use client";
import{useEffect,useState}from"react";
import{loadCustomerBoardingStay,type BoardingStay}from"../../lib/boarding-stay-client";
import styles from"./stay-flow.module.css";
import {plainErrorMessage} from "../../lib/safe-json-response";
import {boardingRequestStatusText,boardingStayHeadline,boardingStayMessage} from "../../lib/boarding-customer-stay-view";
function when(value:string){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"}).format(date):value;}
export default function BoardingCustomerStayStatus({bookingId,caregiverName}:{bookingId:string;caregiverName:string}){const[stay,setStay]=useState<BoardingStay|null>(null),[error,setError]=useState("");useEffect(()=>{let active=true;void loadCustomerBoardingStay(bookingId).then(value=>{if(active){setStay(value);setError("");}}).catch(problem=>{if(active)setError(plainErrorMessage(problem,"Unable to load stay status"));});return()=>{active=false;};},[bookingId]);return<article className={styles.next}><span>BOARDING STAY STATUS</span><h4>{stay?boardingStayHeadline(stay):"Loading stay status…"}</h4><p>{stay?`${boardingStayMessage(stay)} Host: ${stay.provider_name||caregiverName}. Stay window: ${when(stay.check_in_at)} → ${when(stay.check_out_at)}.`:error||"Reading your stay."}</p>{stay?.extension&&<p>Extension: {boardingRequestStatusText(stay.extension.status)}. The original paid checkout remains {when(stay.check_out_at)}.</p>}</article>;}
