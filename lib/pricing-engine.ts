export type PricingPackage={id:string;serviceCode:string;packageCode:string;name:string;description:string;basePrice:number;slotMinutes:number;blockingMinutes:number;taxInclusive:boolean;active:boolean;version:number;effectiveFrom:string;effectiveTo?:string|null};
export type PricingRule={id:string;name:string;serviceCode:string;packageCode?:string|null;cityId:string;zoneId?:string|null;ruleType:"weekday"|"weekend"|"time_band"|"season"|"date_range";days:number[];startTime?:string|null;endTime?:string|null;effectiveFrom:string;effectiveTo?:string|null;adjustmentType:"percent"|"fixed"|"override";adjustmentValue:number;couponPolicy:"stackable"|"exclusive"|"blocked";priority:number;status:"draft"|"approved"|"published"|"paused";version:number};
export type CouponInput={code:string;discountType:"percent"|"fixed";value:number;maxDiscount?:number};
export type PriceQuote={packageCode:string;packageName:string;basePrice:number;dynamicAdjustment:number;priceBeforeCoupon:number;couponDiscount:number;finalPrice:number;taxInclusive:boolean;slotMinutes:number;blockingMinutes:number;couponStatus:"not_applied"|"applied"|"blocked";appliedRules:Array<{id:string;name:string;version:number;amount:number}>;explanation:string[]};
const isoDay=(value:string)=>new Date(value).getDay();
const dateOnly=(value:string)=>value.slice(0,10);
const timeOnly=(value:string)=>new Date(value).toLocaleTimeString("en-GB",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",hour12:false});
const activeOn=(rule:PricingRule,at:string)=>dateOnly(at)>=rule.effectiveFrom&&(!rule.effectiveTo||dateOnly(at)<=rule.effectiveTo);
const matches=(rule:PricingRule,pkg:PricingPackage,at:string,cityId:string,zoneId?:string)=>{
  if(rule.status!=="published"||rule.serviceCode!==pkg.serviceCode||rule.cityId!==cityId)return false;
  if(rule.packageCode&&rule.packageCode!==pkg.packageCode)return false;
  if(rule.zoneId&&rule.zoneId!==zoneId)return false;
  if(!activeOn(rule,at))return false;
  const day=isoDay(at);const time=timeOnly(at);
  if(rule.days.length&&!rule.days.includes(day))return false;
  if(rule.startTime&&time<rule.startTime)return false;
  if(rule.endTime&&time>=rule.endTime)return false;
  return true;
};
export function calculatePrice(input:{pkg:PricingPackage;rules:PricingRule[];scheduledStart:string;cityId:string;zoneId?:string;quantity?:number;coupon?:CouponInput|null}):PriceQuote{
  const quantity=Math.max(1,input.quantity??1);const base=input.pkg.basePrice*quantity;let running=base;
  const applied=input.rules.filter(rule=>matches(rule,input.pkg,input.scheduledStart,input.cityId,input.zoneId)).sort((a,b)=>a.priority-b.priority).map(rule=>{
    const before=running;if(rule.adjustmentType==="override")running=rule.adjustmentValue*quantity;else if(rule.adjustmentType==="percent")running+=running*(rule.adjustmentValue/100);else running+=rule.adjustmentValue*quantity;return {id:rule.id,name:rule.name,version:rule.version,amount:Math.round(running-before),couponPolicy:rule.couponPolicy};
  });
  const beforeCoupon=Math.max(0,Math.round(running));const couponBlocked=applied.some(rule=>rule.couponPolicy==="blocked"||rule.couponPolicy==="exclusive");let couponDiscount=0;
  if(input.coupon&&!couponBlocked){couponDiscount=input.coupon.discountType==="percent"?beforeCoupon*(input.coupon.value/100):input.coupon.value;couponDiscount=Math.min(couponDiscount,input.coupon.maxDiscount??couponDiscount,beforeCoupon);}
  const publicApplied=applied.map(rule=>({id:rule.id,name:rule.name,version:rule.version,amount:rule.amount}));
  return {packageCode:input.pkg.packageCode,packageName:input.pkg.name,basePrice:base,dynamicAdjustment:beforeCoupon-base,priceBeforeCoupon:beforeCoupon,couponDiscount:Math.round(couponDiscount),finalPrice:Math.max(0,beforeCoupon-Math.round(couponDiscount)),taxInclusive:input.pkg.taxInclusive,slotMinutes:input.pkg.slotMinutes,blockingMinutes:input.pkg.blockingMinutes,couponStatus:!input.coupon?"not_applied":couponBlocked?"blocked":"applied",appliedRules:publicApplied,explanation:[`${input.pkg.name} base price ₹${base}`,publicApplied.length?`${publicApplied.length} published dynamic rule${publicApplied.length>1?"s":""} applied`:"No dynamic rule applied",input.coupon?(couponBlocked?"Coupon blocked by the active price rule":`Coupon ${input.coupon.code} applied after dynamic pricing`):"No coupon applied"]};
}
