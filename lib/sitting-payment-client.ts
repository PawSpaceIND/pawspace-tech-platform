export type SittingSandboxCapture={quoteId:string;status:"captured";amount:number;currency:string;environment:"sandbox";reference:string;duplicatePrevented:boolean;liveMoney:false;synthetic:true};

export async function captureSittingQuoteSandbox(input:{quoteId:string;amount:number}){
 const response=await fetch("/api/sitting-payment-sandbox",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
 const body=await response.json() as {data?:SittingSandboxCapture;error?:string};
 if(!response.ok||!body.data)throw new Error(body.error??"Sitting sandbox capture failed");
 return body.data;
}