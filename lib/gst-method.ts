/**
 * THE GST arithmetic for every PawSpace service (owner decision 1, 26 Sept 2026). Pure: no database, no
 * runtime imports, so the Finance screen can show the same worked example the engine computes.
 *
 * One Finance setting (lib/gst-setting.ts) holds a rate and a method; every service GST calculation calls
 * gstOn(base, policy) with it. No vertical keeps its own formula.
 *   percent_of_base   (the owner's default)  GST = rate% x base.            Rs 1,000 -> 180; Rs 300 -> 54.
 *   extract_inclusive (if the CA says so)    GST = base x rate/(100+rate).  Rs 1,000 -> 152.54; Rs 300 -> 45.76.
 * "base" is whatever the rule taxes: PawSpace's commission on a commission job, the whole paid amount on
 * PawSpace's own supply. Exempt supplies (funeral / memorial) never call this - their GST is 0.
 */
export type GstMethod="percent_of_base"|"extract_inclusive";
export type GstPolicy={ratePercent:number;method:GstMethod};
export const GST_METHODS:readonly GstMethod[]=["percent_of_base","extract_inclusive"];
export const DEFAULT_GST_POLICY:Readonly<GstPolicy>=Object.freeze({ratePercent:18,method:"percent_of_base"});
export const GST_METHOD_LABELS:Record<GstMethod,string>={percent_of_base:"GST is the rate applied to the amount",extract_inclusive:"GST is taken out of an amount that already includes it"};
const money=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
export function isGstMethod(value:unknown):value is GstMethod{return value==="percent_of_base"||value==="extract_inclusive";}
/** Why a rate/method pair cannot be used, or null. The setting store and the screen share it. */
export function gstPolicyProblem(input:{ratePercent:unknown;method:unknown}){const rate=Number(input.ratePercent);if(!Number.isFinite(rate)||rate<0||rate>40)return"GST rate must be between 0 and 40 percent";if(!isGstMethod(input.method))return"GST method must be percent_of_base or extract_inclusive";return null;}
/** GST owed on `base` under the setting. Rounded to paise. */
export function gstOn(base:number,policy:GstPolicy){const amount=Math.max(0,Number(base||0)),rate=Number(policy.ratePercent);if(!(amount>0)||!(rate>0))return 0;return policy.method==="extract_inclusive"?money(amount*rate/(100+rate)):money(amount*rate/100);}
/** The GST and the value it is charged on (what a return files as taxable). percent_of_base taxes the whole
 * base; extract_inclusive treats the base as GST-inclusive, so the taxable value is the base less the GST. */
export function gstBreakdown(base:number,policy:GstPolicy){const amount=money(Math.max(0,Number(base||0))),gst=gstOn(amount,policy);return{base:amount,gst,taxableValue:policy.method==="extract_inclusive"?money(amount-gst):amount,ratePercent:Number(policy.ratePercent),method:policy.method};}
