import { calculatePrice, type PricingPackage, type PricingRule } from "./pricing-engine";

type Db=D1Database;
type Row=Record<string,unknown>;

/**
 * The real fix for the Pricing Control panel disconnect: if ops has published a real price for this
 * package in service_packages (via the Pricing Control panel), use it - including any published
 * dynamic pricing rule - through the exact same calculatePrice() the panel's own preview uses.
 * If nothing has ever been configured there for this package, return the caller's existing fallback
 * UNCHANGED - so every package nobody has touched in the panel behaves byte-for-byte identically to
 * before this fix, and only packages someone has actually gone and priced take on the new behavior.
 * This is deliberately additive, not a replacement of each vertical's own governance.
 */
export async function resolveLivePrice(db:Db,input:{packageCode:string;fallbackPrice:number;scheduledStart:string;cityId:string;zoneId?:string;quantity?:number}):Promise<{price:number;source:"pricing_control"|"fallback_default"}>{
  const row=await db.prepare("SELECT * FROM service_packages WHERE package_code=? AND active=1").bind(input.packageCode).first<Row>();
  if(!row)return{price:input.fallbackPrice,source:"fallback_default"};
  const pkg:PricingPackage={
    id:String(row.id),serviceCode:String(row.service_code),packageCode:String(row.package_code),name:String(row.name),description:String(row.description),
    basePrice:Number(row.base_price),slotMinutes:Number(row.slot_minutes),blockingMinutes:Number(row.blocking_minutes),taxInclusive:Boolean(row.tax_inclusive),
    active:Boolean(row.active),version:Number(row.version),effectiveFrom:String(row.effective_from),effectiveTo:row.effective_to?String(row.effective_to):null,
  };
  const raw=await db.prepare("SELECT * FROM dynamic_pricing_rules WHERE status='published' AND service_code=?").bind(pkg.serviceCode).all<Row>();
  const rules:PricingRule[]=raw.results.map(rule=>({
    id:String(rule.id),name:String(rule.name),serviceCode:String(rule.service_code),packageCode:rule.package_code?String(rule.package_code):null,
    cityId:String(rule.city_id),zoneId:rule.zone_id?String(rule.zone_id):null,ruleType:String(rule.rule_type) as PricingRule["ruleType"],
    days:JSON.parse(String(rule.days_json)),startTime:rule.start_time?String(rule.start_time):null,endTime:rule.end_time?String(rule.end_time):null,
    effectiveFrom:String(rule.effective_from),effectiveTo:rule.effective_to?String(rule.effective_to):null,
    adjustmentType:String(rule.adjustment_type) as PricingRule["adjustmentType"],adjustmentValue:Number(rule.adjustment_value),
    couponPolicy:String(rule.coupon_policy) as PricingRule["couponPolicy"],priority:Number(rule.priority),status:String(rule.status) as PricingRule["status"],version:Number(rule.version),
  }));
  const quote=calculatePrice({pkg,rules,scheduledStart:input.scheduledStart,cityId:input.cityId,zoneId:input.zoneId,quantity:input.quantity});
  return{price:quote.finalPrice,source:"pricing_control"};
}
