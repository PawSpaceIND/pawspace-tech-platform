export type TcsRateS52={total:number;cgst:number;sgst:number;igst:number;version:string;effectiveFrom:string};
const IST_OFFSET_MS=330*60_000;
const CHANGE_DATE="2024-07-10";
const LEGACY_RATE:TcsRateS52={total:0.01,cgst:0.005,sgst:0.005,igst:0.01,version:"s52-1pct-through-2024-07-09",effectiveFrom:"2018-10-01"};
export const TCS_RATE_S52:TcsRateS52={total:0.005,cgst:0.0025,sgst:0.0025,igst:0.005,version:"s52-0.5pct-from-2024-07-10",effectiveFrom:CHANGE_DATE};
/*
 * The India calendar date a rate applies on. The s.52 TCS rate halved from 1% to 0.5% on
 * 2024-07-10, so this one date decides the rate, and getting it wrong misstates the tax by 2x.
 *
 * A string used to be handled by slicing the first ten characters whenever it merely STARTED with
 * a date, while a number or a Date was shifted into IST first. Those disagreed about the same
 * instant: "2024-07-09T23:00:00Z" is 04:30 on 2024-07-10 in India, and it returned 1% as a string
 * and 0.5% as the epoch milliseconds of that identical moment. Every caller today passes a number,
 * so nothing was misfiled - but an ISO timestamp is exactly what this codebase stores in
 * canonical_bookings.scheduled_start, so the next caller to pass one would have got the wrong rate
 * silently. A string that names an INSTANT is now converted like an instant. [D31-W1b]
 */
function indiaDate(value:string|number|Date){
 if(value==null)throw new Error("Invalid TCS effective date");
 /*
  * A non-positive instant is not a real effective date, and must not resolve to one. Number(null)
  * is 0 and 0 is finite, so a NULL timestamp read out of the database used to land on 1970-01-01
  * and come back as the LEGACY 1% rate - double the current 0.5%. That is a live path:
  * computeMonthlyTcsStatutory() resolves the rate as tcsRateS52For(num(p.computed_at)), and
  * provider_payout_computations.computed_at carries no NOT NULL guarantee here. Fail loudly, the
  * way this module already fails on a missing provider GSTIN, rather than filing a wrong rate.
  * [D31-W1b]
  */
 const fromInstant=(time:number)=>{if(!Number.isFinite(time)||time<=0)throw new Error("Invalid TCS effective date");return new Date(time+IST_OFFSET_MS).toISOString().slice(0,10);};
 if(typeof value==="string"){
  const text=value.trim();
  // Date-only: already an India business date, use it as written - once it is a date that exists.
  // The shape check alone accepted "2024-13-45", which then compared as a plain string against the
  // change date and resolved to a real rate. A tax rate must never come back from a date that is
  // not a date. [D31-W1b]
  if(/^\d{4}-\d{2}-\d{2}$/.test(text)){
   const parsed=new Date(`${text}T00:00:00Z`);
   if(Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==text)throw new Error("Invalid TCS effective date");
   return text;
  }
  // Carries an explicit zone: names an instant, so resolve it to the India date of that instant.
  if(/^\d{4}-\d{2}-\d{2}[T ].*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text))return fromInstant(Date.parse(text));
  // A wall-clock timestamp with no zone is already India local time; its date part is the answer.
  if(/^\d{4}-\d{2}-\d{2}[T ]/.test(text))return text.slice(0,10);
  return fromInstant(Date.parse(text));
 }
 return fromInstant(value instanceof Date?value.getTime():Number(value));
}
export function tcsRateS52For(value:string|number|Date):TcsRateS52{return indiaDate(value)>=CHANGE_DATE?TCS_RATE_S52:LEGACY_RATE;}
