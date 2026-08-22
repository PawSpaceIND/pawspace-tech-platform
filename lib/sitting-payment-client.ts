import {apiSend} from "./api-fetch";

export type SittingSandboxCapture={quoteId:string;status:"captured";amount:number;currency:string;environment:"sandbox";reference:string;duplicatePrevented:boolean;liveMoney:false;synthetic:true};

const captureKeys=new Map<string,string>();
function captureKeyForQuote(quoteId:string){
 const existing=captureKeys.get(quoteId);if(existing)return existing;
 const created=crypto.randomUUID();captureKeys.set(quoteId,created);return created;
}

export async function captureSittingQuoteSandbox(input:{quoteId:string;amount:number}){
 const paymentKey=captureKeyForQuote(input.quoteId);
 return apiSend<SittingSandboxCapture>("/api/sitting-payment-sandbox",{method:"POST",headers:{"content-type":"application/json","x-payment-capture-key":paymentKey},body:JSON.stringify(input)},"Sitting sandbox capture failed");
}
