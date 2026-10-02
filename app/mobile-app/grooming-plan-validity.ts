"use client";
import {useEffect,useState} from "react";
import {loadV2CustomerAccount} from "../../lib/v2/customer-experience-client";
import {loadV2GroomingCatalogue} from "../../lib/v2/grooming-client";
import type {PublicGroomingSubscription} from "../../lib/v2/grooming-subscription-projection";

/** Display only. Prices, selected plans and booking/payment inputs remain owned by the existing flow. */
export function groomingPlanValidityLabels(plans:PublicGroomingSubscription[]){
 const labels:Record<string,string>={};
 for(const p of plans){if(!Number.isSafeInteger(p.validityValue)||p.validityValue<1||!['days','months'].includes(p.validityUnit))continue;labels[p.code]=`${p.validityValue} ${p.validityValue===1?p.validityUnit.slice(0,-1):p.validityUnit}`;}
 return labels;
}
export function useGroomingPlanValidity(input:{customerId?:string;cityId?:string;zoneId?:string;date:string}):{labels:Record<string,string>;message:string}{
 const requestKey=JSON.stringify([input.customerId,input.cityId,input.zoneId,input.date]);
 const [state,setState]=useState<{key:string;labels:Record<string,string>;message:string}>({key:'',labels:{},message:'Check your service area to see current validity'});
 useEffect(()=>{let live=true;async function load(){
  if(!input.cityId&&!input.customerId){if(live)setState({key:requestKey,labels:{},message:'Check your service area to see current validity'});return;}
  if(live)setState({key:requestKey,labels:{},message:'Checking current plan validity…'});
  try{
   const account=input.cityId?null:await loadV2CustomerAccount();
   if(account&&account.customerId!==input.customerId)throw new Error('Customer profile did not match');
   const cityId=input.cityId||account?.cityId;
   if(!cityId)throw new Error('Select a service area');
   const catalogue=await loadV2GroomingCatalogue({cityId,...(input.zoneId?{zoneId:input.zoneId}:{}),date:input.date});
   if(live)setState({key:requestKey,labels:groomingPlanValidityLabels(catalogue.subscriptions??[]),message:'Not published for this service area and date'});
  }catch{if(live)setState({key:requestKey,labels:{},message:'Current validity unavailable — check your service area'});}
 }void load();return()=>{live=false;};},[input.customerId,input.cityId,input.zoneId,input.date,requestKey]);
 return state.key===requestKey?state:{labels:{},message:input.cityId||input.customerId?'Checking current plan validity…':'Check your service area to see current validity'};
}
