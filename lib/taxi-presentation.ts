const currency = new Intl.NumberFormat("en-IN", {style:"currency",currency:"INR",minimumFractionDigits:0,maximumFractionDigits:2});
export const taxiMoney = (amount:number) => currency.format(amount);
export function taxiRouteNotice(source:string){
 return source==="google_routes_uat"
  ? "Google Routes sandbox estimate. Distance and travel time are not production verified."
  : source==="sandbox_route_fallback"
   ? "Sandbox fallback estimate. This distance and travel time are test values, not a measured route."
   : "Sandbox route estimate. Distance and travel time are not production verified.";
}
