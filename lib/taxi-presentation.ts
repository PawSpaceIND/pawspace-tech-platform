const wholeRupees = new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:0,maximumFractionDigits:0});
const withPaise = new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:2,maximumFractionDigits:2});
/**
 * A Pet Taxi rupee amount as the customer is charged it: whole rupees as ₹675, anything with paise to
 * exactly two places (₹722.80, ₹303.73 - never ₹722.8, never rounded to ₹304). An amount that is missing
 * or not a number reads "—" rather than "₹NaN" or a made-up ₹0.
 */
export const taxiMoney = (amount:unknown) => {
 const value = typeof amount==="number"?amount:typeof amount==="string"&&amount.trim()?Number(amount):Number.NaN;
 if(!Number.isFinite(value))return "—";
 const paise = Math.round(value*100);
 return paise%100===0?wholeRupees.format(paise/100):withPaise.format(paise/100);
};
export function taxiRouteNotice(source:string){
 return source==="google_routes_uat"
  ? "Google Routes sandbox estimate. Distance and travel time are not production verified."
  : source==="sandbox_route_fallback"
   ? "Sandbox fallback estimate. This distance and travel time are test values, not a measured route."
   : "Sandbox route estimate. Distance and travel time are not production verified.";
}
