export type TcsRateS52={total:number;cgst:number;sgst:number;igst:number;version:string;effectiveFrom:string};

const IST_OFFSET_MS=330*60_000;
const CHANGE_DATE="2024-07-10";
const LEGACY_RATE:TcsRateS52={total:0.01,cgst:0.005,sgst:0.005,igst:0.01,version:"s52-1pct-through-2024-07-09",effectiveFrom:"2018-10-01"};
export const TCS_RATE_S52:TcsRateS52={total:0.005,cgst:0.0025,sgst:0.0025,igst:0.005,version:"s52-0.5pct-from-2024-07-10",effectiveFrom:CHANGE_DATE};

function indiaDate(value:string|number|Date){
 if(typeof value==="string"){
  const text=value.trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(text))return text.slice(0,10);
  const parsed=Date.parse(text);if(!Number.isFinite(parsed))throw new Error("Invalid TCS effective date");
  return new Date(parsed+IST_OFFSET_MS).toISOString().slice(0,10);
 }
 const time=value instanceof Date?value.getTime():Number(value);
 if(!Number.isFinite(time))throw new Error("Invalid TCS effective date");
 return new Date(time+IST_OFFSET_MS).toISOString().slice(0,10);
}

export function tcsRateS52For(value:string|number|Date):TcsRateS52{
 return indiaDate(value)>=CHANGE_DATE?TCS_RATE_S52:LEGACY_RATE;
}
