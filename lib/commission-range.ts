/**
 * PawSpace's commission range and the plain-English split preview (owner decision 8, 26 Sept 2026).
 * Pure: no database and no runtime imports, so the Finance and onboarding screens show exactly what the
 * server enforces and computes.
 *
 * On every commission service PawSpace's commission is 10% to 40% of the amount the customer paid; the
 * provider gets the rest. The default is 30% everywhere until the owner gives per-service numbers. The range
 * holds for service defaults, provider terms and per-order overrides. It applies to the commission models
 * only: funeral / memorial is not a commission service (owner decisions 2 and 4) and a full-time contractor
 * has no share at all (decision 7).
 *
 * Stored terms keep the PROVIDER's share as a fraction (provider_share_pct); people set PawSpace's
 * commission as a percentage. The two helpers below are the only conversion between them.
 */
import{DEFAULT_GST_POLICY,gstOn,type GstPolicy}from"./gst-method";

export const PAWSPACE_COMMISSION_MIN_PERCENT=10;
export const PAWSPACE_COMMISSION_MAX_PERCENT=40;
export const PAWSPACE_COMMISSION_DEFAULT_PERCENT=30;
/** The engagement models PawSpace earns a marketplace commission on; the range applies to these. */
export const RANGE_GOVERNED_MODELS:ReadonlySet<string>=new Set(["commission_groomer","commission_standard"]);
/** What staff choose for a provider. Each maps to one engagement model per service (see engagementModelFor). */
export type ProviderEngagement="commission"|"full_time"|"funeral_vendor";
export const PROVIDER_ENGAGEMENTS:readonly ProviderEngagement[]=["commission","full_time","funeral_vendor"];
export const PROVIDER_ENGAGEMENT_LABELS:Record<ProviderEngagement,string>={commission:"Commission (paid a share of each booking)",full_time:"Full-time contractor (monthly fee, no share)",funeral_vendor:"Funeral / memorial vendor (share of each case, no GST)"};
const GROOMING_SERVICE_CODES:ReadonlySet<string>=new Set(["grooming","pet_grooming"]);
const FUNERAL_CODES:ReadonlySet<string>=new Set(["funeral","funeral_memorial"]);

const round2=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
export function isProviderEngagement(value:unknown):value is ProviderEngagement{return value==="commission"||value==="full_time"||value==="funeral_vendor";}
/** Commission for a groomer keeps the groomer defaults (cash allowed); every other commission service is the standard model. A funeral service is always the exempt model. */
export function engagementModelFor(engagement:ProviderEngagement,serviceCode:string){const code=String(serviceCode||"").trim().toLowerCase();if(engagement==="full_time")return"direct_employee" as const;if(engagement==="funeral_vendor"||FUNERAL_CODES.has(code))return"funeral_exempt" as const;return GROOMING_SERVICE_CODES.has(code)?"commission_groomer" as const:"commission_standard" as const;}
export function engagementOfModel(model:string):ProviderEngagement|null{if(model==="direct_employee")return"full_time";if(model==="funeral_exempt")return"funeral_vendor";if(RANGE_GOVERNED_MODELS.has(model))return"commission";return null;}
/** PawSpace's commission % -> the provider's share as a stored fraction (30 -> 0.7). */
export function providerShareFromCommission(pawspaceCommissionPercent:number){return round2(100-Number(pawspaceCommissionPercent))/100;}
/** A stored provider share fraction -> PawSpace's commission % (0.7 -> 30). */
export function commissionFromProviderShare(providerSharePct:number){return round2((1-Number(providerSharePct))*100);}
const percentText=(v:number)=>`${round2(v)}%`;
/** Why PawSpace's commission % cannot be used on a commission service, or null. `label` names the service in the message. */
export function pawspaceCommissionProblem(percent:unknown,label=""){const value=Number(percent),where=label?` for ${label}`:"";if(percent===""||percent==null||!Number.isFinite(value))return`Enter PawSpace's commission${where} as a percentage between ${PAWSPACE_COMMISSION_MIN_PERCENT}% and ${PAWSPACE_COMMISSION_MAX_PERCENT}%.`;if(value<PAWSPACE_COMMISSION_MIN_PERCENT)return`PawSpace's commission${where} cannot be below ${PAWSPACE_COMMISSION_MIN_PERCENT}% of the amount paid (you entered ${percentText(value)}).`;if(value>PAWSPACE_COMMISSION_MAX_PERCENT)return`PawSpace's commission${where} cannot be above ${PAWSPACE_COMMISSION_MAX_PERCENT}% of the amount paid (you entered ${percentText(value)}).`;return null;}
/** The same check on a stored provider share: null when the model is not range-governed or the share is inside the range. */
export function providerShareRangeProblem(model:string,providerSharePct:number,label=""){if(!RANGE_GOVERNED_MODELS.has(model))return null;return pawspaceCommissionProblem(commissionFromProviderShare(providerSharePct),label);}
/** A funeral vendor's PawSpace share is a percentage of the paid amount; it only has to be a real split. */
export function funeralSharePercentProblem(percent:unknown,label=""){const value=Number(percent),where=label?` for ${label}`:"";if(percent===""||percent==null||!Number.isFinite(value)||value<0||value>=100)return`Enter PawSpace's share${where} as a percentage from 0% to below 100%.`;return null;}

export const rupeesText=(value:number)=>`Rs ${round2(value).toLocaleString("en-IN",{minimumFractionDigits:0,maximumFractionDigits:2})}`;
export type CommissionPreview={paidAmount:number;providerGets:number;pawspaceKeeps:number;gst:number;pawspaceAfterGst:number;sentence:string};
/**
 * The worked example staff see before saving: what the provider gets, what PawSpace keeps and the GST it pays,
 * on a booking of `paidAmount` (Rs 1,000 by default), under the one GST setting. Same arithmetic as
 * splitServiceOrder in lib/provider-commercial-terms.ts.
 */
export function commissionPreview(input:{engagement:ProviderEngagement;pawspaceCommissionPercent?:number|null;gstPolicy?:GstPolicy|null;paidAmount?:number}):CommissionPreview{
 const paid=round2(Number(input.paidAmount??1000)),policy=input.gstPolicy??DEFAULT_GST_POLICY,booking=`On a ${rupeesText(paid)} booking`;
 if(input.engagement==="full_time"){const gst=gstOn(paid,policy);return{paidAmount:paid,providerGets:0,pawspaceKeeps:paid,gst,pawspaceAfterGst:round2(paid-gst),sentence:`${booking}: PawSpace keeps ${rupeesText(paid)} and pays ${rupeesText(gst)} GST. The provider is paid a monthly fee through Contractor pay, not a share.`};}
 const percent=Number(input.pawspaceCommissionPercent??PAWSPACE_COMMISSION_DEFAULT_PERCENT),providerGets=round2(paid*providerShareFromCommission(percent)),pawspaceKeeps=round2(paid-providerGets);
 if(input.engagement==="funeral_vendor")return{paidAmount:paid,providerGets,pawspaceKeeps,gst:0,pawspaceAfterGst:pawspaceKeeps,sentence:`${booking}: provider gets ${rupeesText(providerGets)}, PawSpace keeps ${rupeesText(pawspaceKeeps)} and pays no GST (funeral and memorial are GST exempt)`};
 const gst=gstOn(pawspaceKeeps,policy);
 return{paidAmount:paid,providerGets,pawspaceKeeps,gst,pawspaceAfterGst:round2(pawspaceKeeps-gst),sentence:`${booking}: provider gets ${rupeesText(providerGets)}, PawSpace keeps ${rupeesText(pawspaceKeeps)} and pays ${rupeesText(gst)} GST`};
}
/** Every problem with a provider's proposed terms, in plain words (empty when they can be saved). The server refuses the same list the screens show. */
export function providerTermsProblems(input:{engagement:unknown;services:ReadonlyArray<{serviceCode:unknown;pawspaceCommissionPercent?:unknown}>}){
 if(!isProviderEngagement(input.engagement))return["Choose how the provider is engaged: commission, full-time contractor or funeral / memorial vendor."];
 const engagement=input.engagement,problems:string[]=[],code=(v:unknown)=>String(v??"").trim().toLowerCase();
 if(!input.services.some(s=>code(s.serviceCode)))problems.push("Add at least one service the provider offers.");
 for(const item of input.services){const service=code(item.serviceCode);if(!service)continue;const model=engagementModelFor(engagement,service),raw=item.pawspaceCommissionPercent,percent=raw===""||raw==null?PAWSPACE_COMMISSION_DEFAULT_PERCENT:raw,label=service.replaceAll("_"," ");if(model==="direct_employee")continue;/* GST exemption follows the service: a funeral vendor term on any other service would make it GST exempt */if(engagement==="funeral_vendor"&&!FUNERAL_CODES.has(service)){problems.push(`A funeral / memorial vendor can only be set for funeral or memorial services, not ${label}.`);continue;}const problem=model==="funeral_exempt"?funeralSharePercentProblem(percent,label):pawspaceCommissionProblem(percent,label);if(problem)problems.push(problem);}
 return problems;
}
