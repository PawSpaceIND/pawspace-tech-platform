import { defaultStayAddress, validateSavedStayAddress, type SavedStayAddress } from "./stay-saved-address";

/** The delivery selection a Food page quotes and orders for, taken from the customer's own saved default address. */
export type FoodDeliveryChoice = Readonly<{ address: string; pincode: string; cityId: string; zoneId: string }>;

/**
 * The customer's saved default address, validated under the strict PIN contract and governed coverage. A missing or
 * malformed saved PIN refuses with a correction prompt: it never falls back to another saved address, to a PIN found
 * in the address text, or to a default city or zone, and the saved record is never rewritten.
 */
export async function foodDeliveryFromAccount(account: { addresses: SavedStayAddress[] }, signal?: AbortSignal): Promise<FoodDeliveryChoice> {
  const saved = defaultStayAddress(account.addresses);
  if (!saved) throw new Error("Add a delivery address in My PawSpace before ordering Fresh Food.");
  const location = await validateSavedStayAddress(saved, signal);
  return Object.freeze({ address: location.address, pincode: location.assignment.pincode, cityId: location.assignment.cityId, zoneId: location.assignment.zoneId });
}
