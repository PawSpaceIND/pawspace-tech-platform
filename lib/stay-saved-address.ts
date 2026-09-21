import type { CustomerAccountRecord } from "./customer-account";
import type { ZoneResult } from "../app/mobile-app/address-picker";
import { resolveServiceCoverage } from "./service-zone-client";
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
  const pin = address.postalCode?.replace(/\D/g, "") || savedStayAddressText(address).match(/\b[1-9]\d{5}\b/)?.[0] || "";
  if (!/^[1-9]\d{5}$/.test(pin)) throw new Error("Add the PIN code to this address so we can check availability.");
  const coverage = await resolveServiceCoverage(pin, signal);
  return { address: savedStayAddressText(address), zone: coverage.zone,
    assignment: { pincode: coverage.pincode, cityId: coverage.cityId, city: coverage.city, zoneId: coverage.zoneId, area: coverage.area } };
}
