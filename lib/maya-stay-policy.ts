/** Model-facing descriptions retain care choices, never fixed provider-price claims. */
export const MAYA_STAY_POLICY = "Boarding, Daycare and Pet Sitting prices depend on the available host or sitter and their published rates. Catalogue defaults are not customer quotes. Explain care options without a fixed price. A verified named caregiver quote is information only, not acceptance or a reservation. The customer completes selection, booking and payment in the PawSpace app; unresolved rates or care needs go to staff.";
const allowed = new Set(["package_code", "name", "care_kind", "mode", "max_hours", "currency", "version"]);
export function mayaStayDescriptions(value: unknown) {
 if (!Array.isArray(value)) return [];
 return value.filter(row => row && typeof row === "object" && !Array.isArray(row)).map(row => ({
  ...Object.fromEntries(Object.entries(row).filter(([key]) => allowed.has(key))),
  pricingBasis: "available_provider_quote", bookingChannel: "customer_app",
 }));
}
