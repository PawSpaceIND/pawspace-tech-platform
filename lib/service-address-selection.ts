// @ts-expect-error Node 22 strip-types requires the explicit .ts extension at runtime.
import { validateIndianPincode } from "./pincode-validation.ts";

/**
 * One customer-selected service address, frozen when the customer confirms. Every request that follows (the
 * reservation, the post-booking doorstep save, a replay) reads this snapshot and never the live form state, so an
 * address changed while a request is in flight cannot change what is reserved or persisted. The doorstep the
 * server binds to the reservation is decided server-side; nothing here is address authority.
 */
export type ServiceAddressSelection = Readonly<{
  customerId: string;
  address: string;
  pincode: string;
  cityId?: string;
  zoneId?: string;
  window?: Readonly<{ start: string; end: string }>;
  /** Only a hint the server may verify against map data; never stored as authority by the client. */
  latitude?: number;
  longitude?: number;
}>;

export class ServiceAddressSelectionError extends Error {
  constructor(message: string) { super(message); this.name = "ServiceAddressSelectionError"; }
}

export function freezeServiceAddressSelection(input: {
  customerId: string; address: string; pincode: string; cityId?: string; zoneId?: string;
  window?: { start: string; end: string }; latitude?: number; longitude?: number;
}): ServiceAddressSelection {
  const customerId = String(input.customerId || "").trim(), address = String(input.address || "").trim();
  if (!customerId) throw new ServiceAddressSelectionError("Sign in again before booking.");
  if (address.length < 8) throw new ServiceAddressSelectionError("Enter your complete service address before booking.");
  const pin = validateIndianPincode(input.pincode);
  if (!pin.ok) throw new ServiceAddressSelectionError(pin.reason === "missing" ? "Enter the six-digit PIN code for this address." : "Enter a valid six-digit PIN code: six digits only, with no spaces or other characters.");
  const hint = Number.isFinite(input.latitude) && Number.isFinite(input.longitude) ? { latitude: Number(input.latitude), longitude: Number(input.longitude) } : {};
  return Object.freeze({
    customerId, address, pincode: pin.pincode,
    ...(input.cityId ? { cityId: input.cityId } : {}), ...(input.zoneId ? { zoneId: input.zoneId } : {}),
    ...(input.window ? { window: Object.freeze({ start: input.window.start, end: input.window.end }) } : {}),
    ...hint,
  });
}

/** Identity of the selection, for request ids and stale-answer checks. */
export function serviceAddressSelectionKey(selection: ServiceAddressSelection): string {
  return JSON.stringify([selection.customerId, selection.address, selection.pincode, selection.cityId ?? "", selection.zoneId ?? "", selection.window?.start ?? "", selection.window?.end ?? ""]);
}

/** A scheduling request carrying exactly the frozen address and PIN, so no remembered draft can replace them. */
export function withServiceAddress<T extends object>(request: T, selection: ServiceAddressSelection): T & { serviceAddress: string; servicePincode: string } {
  return { ...request, serviceAddress: selection.address, servicePincode: selection.pincode };
}

/** The post-booking doorstep save, from the same frozen selection. Coordinates go only as a verification hint. */
export function doorstepSaveBody(selection: ServiceAddressSelection, bookingId: string) {
  return {
    bookingId, customerId: selection.customerId, address: selection.address, pincode: selection.pincode,
    ...(selection.latitude !== undefined && selection.longitude !== undefined ? { latitude: selection.latitude, longitude: selection.longitude } : {}),
  };
}
