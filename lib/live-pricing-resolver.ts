import { calculatePrice, type PricingPackage, type PricingRule } from "./pricing-engine";
import { ensurePricingControlRuntime } from "./pricing-control-runtime";

type Db=D1Database;
type Row=Record<string,unknown>;

/**
 * Reads the operator-controlled package/rule state when that exact canonical package has been
 * explicitly activated in Pricing Control. Canonical rows are self-provisioned inactive at their
 * existing catalogue prices, so merely deploying this bridge cannot change a customer price.
 * Existing operator edits are preserved by INSERT OR IGNORE. If the row remains inactive, callers
 * get their pre-existing fallback unchanged.
 */
export async function resolveLivePrice(db:Db,input:{packageCode:string;fallbackPrice:number;scheduledStart:string;cityId:string;zoneId?:string;quantity?:number}):Promise<{price:number;source:"pricing_control"|"fallback_default"}>{
  await ensurePricingControlRuntime(db);
  const row=await db.prepare("SELECT * FROM service_packages WHERE package_code=? AND active=1").bind(input.packageCode).first<Row>();
  if(!row)return{price:input.fallbackPrice,source:"fallback_default"};
  // A package is only a price INSIDE its own effective window. `active=1` says an operator has switched
  // the row on; effective_from/effective_to say WHEN it applies, and the Pricing Control panel exposes
  // both as a first-class "Effective from" control. Without this test a price scheduled for 2027 was
  // quoted - and in the grooming booking path ENFORCED, with the true catalogue price rejected 409 -
  // for a stay today, and a price retired in 2025 was quoted forever.
  //
  // The comparison is deliberately the SAME one lib/pricing-engine.ts activeOn() already applies to
  // dynamic_pricing_rules: date-only, inclusive at both ends, judged against the BOOKING date rather
  // than today. Only the package row was exempt from it. Out of window falls back exactly as an absent
  // or inactive row does, so no caller learns a new failure mode.
  const bookingDay=String(input.scheduledStart).slice(0,10);
  const from=String(row.effective_from||"").slice(0,10),to=row.effective_to?String(row.effective_to).slice(0,10):null;
  if((from&&bookingDay<from)||(to&&bookingDay>to))return{price:input.fallbackPrice,source:"fallback_default"};
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
