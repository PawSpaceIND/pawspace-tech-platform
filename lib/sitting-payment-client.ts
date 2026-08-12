import {apiSend} from "./api-fetch";

export type SittingSandboxCapture={quoteId:string;status:"captured";amount:number;currency:string;environment:"sandbox";reference:string;duplicatePrevented:boolean;liveMoney:false;synthetic:true};

export async function captureSittingQuoteSandbox(input:{quoteId:string;amount:number}){
 return apiSend<SittingSandboxCapture>("/api/sitting-payment-sandbox",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)},"Sitting sandbox capture failed");
}
