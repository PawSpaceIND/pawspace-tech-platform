/** Owner-approved 1 October 2026. Read-only Maya reference, not a booking/payment adapter.
 * Supersedes website electric cremation 7,999 and ash plantation 7,000 for new enquiries.
 * Existing purchased terms and canonical accounting are unchanged.
 */
export const MAYA_FUNERAL_POLICY = {
 version: "owner-2026-10-01",
 currency: "INR",
 timezone: "Asia/Kolkata",
 pickupCutoffHour: 16,
 centreClosingHour: 17,
 afterCutoff: "Overnight freezer care after pickup; chosen farewell next day, with staff-confirmed arrangements",
 advancePercent: 50,
 balancePercent: 50,
 paymentChannel: "Razorpay",
 execution: "staff_required",
 ashCollectionHours: { minimum: 3, maximum: 4 },
 requiredIntake: ["farewellChoice", "pickupRequired", "primaryContactName", "primaryContactPhone", "secondaryContactName", "secondaryContactPhone", "pickupAddress", "pickupPincode", "requestedDate", "requestedTime", "petType", "petSize", "familyAttendance", "selectedExtras"],
} as const;

export function mayaFuneralCatalogue() {
 return [
  { package_code: "FUNERAL_ELECTRIC", name: "Electric cremation", base_price: 7000, inclusions: "Pickup and end-to-end coordination; family attendance optional" },
  { package_code: "FUNERAL_BURIAL", name: "Burial", base_price: 9000, inclusions: "Human burial ground; staff shares confirmed location" },
  { package_code: "FUNERAL_WOODEN", name: "Wooden cremation", base_price: 16000, inclusions: "Wooden cremation; staff confirms site and arrangements" },
  { package_code: "FUNERAL_ASH_DELIVERY", name: "Doorstep ash delivery", base_price: 2000, inclusions: "Optional ash collection and doorstep delivery; collection takes approximately 3 to 4 hours" },
  { package_code: "FUNERAL_POOJARI", name: "Poojari", base_price: 6000, inclusions: "Optional last rites, only with consent" },
  { package_code: "FUNERAL_PLANTATION", name: "Ash plantation", base_price: 7500, inclusions: "Optional living memorial; staff confirms kit and arrangements" },
  { package_code: "FUNERAL_FREEZER", name: "Overnight freezer", base_price: 2000, inclusions: "Overnight care after pickup; required for pickup after 4 PM" },
 ].map(row => ({ ...row, currency: "INR", version: MAYA_FUNERAL_POLICY.version, source: "owner_approved_2026_10_01", executable: false }));
}
