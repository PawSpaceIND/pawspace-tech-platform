import type { CustomerAccountRecord } from "./customer-account";
import type { ZoneResult } from "../app/mobile-app/address-picker";
import { resolveServiceCoverage, strictServicePincode } from "./service-zone-client";
import { serviceAddressText } from "./service-address-text";
export type SavedStayAddress = CustomerAccountRecord["addresses"][number];
export type StayLocation = Pick<ZoneResult, "zone" | "assignment" | "address"> & Partial<Pick<ZoneResult, "placeId" | "latitude" | "longitude">>;
export function defaultStayAddress(addresses: SavedStayAddress[]) {
  return addresses.find(address => address.isDefault) ?? addresses[0] ?? null;
}
export function savedStayAddressText(address: SavedStayAddress) {
  return serviceAddressText(address);
}
export async function validateSavedStayAddress(address: SavedStayAddress, signal?: AbortSignal): Promise<StayLocation> {
  // The saved PIN is used exactly as saved (outer whitespace aside). A missing PIN asks for one; a malformed one is
  // refused. Neither falls back to a PIN found in the address text, and the saved record is never rewritten.
  const checked = strictServicePincode(address.postalCode);
  if (!checked.ok) throw new Error(checked.reason === "missing"
    ? "Add the PIN code to this address so we can check availability."
    : "This saved address has an invalid PIN code. Correct it in My PawSpace or choose another address.");
  const coverage = await resolveServiceCoverage(checked.pincode, signal);
  return { address: savedStayAddressText(address), zone: coverage.zone,
    assignment: { pincode: coverage.pincode, cityId: coverage.cityId, city: coverage.city, zoneId: coverage.zoneId, area: coverage.area } };
}
