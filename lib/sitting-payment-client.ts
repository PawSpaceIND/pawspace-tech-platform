import {apiSend} from "./api-fetch";

export type SittingSandboxCapture={quoteId:string;status:"captured";amount:number;currency:string;environment:"sandbox";reference:string;duplicatePrevented:boolean;liveMoney:false;synthetic:true};

export async function captureSittingQuoteSandbox(input:{quoteId:string;amount:number;paymentKey:string}){
 return apiSend<SittingSandboxCapture>("/api/sitting-payment-sandbox",{method:"POST",headers:{"content-type":"application/json","x-payment-capture-key":input.paymentKey},body:JSON.stringify({quoteId:input.quoteId,amount:input.amount})},"Sitting sandbox capture failed");
}
