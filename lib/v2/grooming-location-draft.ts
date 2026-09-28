import { getDeviceLocation } from "../device-location-client";
import { reverseGeocodeCoordinates } from "../address-autocomplete-client";
import { serviceAddressPincodes } from "../service-address-pincode";

/** An address suggestion only. Coordinates are not persisted or passed as checkout authority. */
export type GroomingLocationDraft = { address: string; pincode: string };
type Options = { signal?: AbortSignal; geolocation?: Pick<Geolocation, "getCurrentPosition"> };
function requireActive(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Location request cancelled", "AbortError");
}

/** Called only from the customer's explicit location action; never on page load. */
export async function requestGroomingLocationDraft(options: Options = {}): Promise<GroomingLocationDraft> {
  requireActive(options.signal);
  let coordinates: { latitude: number; longitude: number };
  try { coordinates = await getDeviceLocation(options.geolocation); }
  catch {
    requireActive(options.signal);
    throw new Error("Your current location could not be read. Enter your address and PIN manually, or allow location access and try again.");
  }
  requireActive(options.signal);
  const result = await reverseGeocodeCoordinates(coordinates.latitude, coordinates.longitude, options.signal);
  requireActive(options.signal);
  if (!result || result.status !== "configured") {
    throw new Error("Location lookup is unavailable. Your entered address is unchanged; enter the full address and PIN manually.");
  }
  const address = typeof result.address === "string" ? result.address.trim() : "";
  if (address.length < 8 || address.length > 1000 ||
      !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude) ||
      result.latitude !== coordinates.latitude || result.longitude !== coordinates.longitude) {
    throw new Error("The suggested location could not be verified. Enter your address and PIN manually.");
  }
  const pins = [...new Set(serviceAddressPincodes(address))];
  const structured = result.pincode;
  if (structured !== undefined && (typeof structured !== "string" || !/^[1-9]\d{5}$/.test(structured))) {
    throw new Error("The suggested PIN is invalid. Enter your address and PIN manually.");
  }
  const pincode = structured ?? (pins.length === 1 ? pins[0] : "");
  if (!/^[1-9]\d{5}$/.test(pincode) || pins.some(pin => pin !== pincode)) {
    throw new Error("A single matching PIN could not be verified. Enter your address and PIN manually.");
  }
  return { address, pincode };
}
