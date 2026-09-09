import type { AddressSuggestion, AutocompleteResult, ResolvedAddress } from "./address-autocomplete";

async function payload<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { data?: T; error?: string };
  if (!response.ok) throw new Error(body.error || "Address lookup failed");
  return body.data as T;
}

export async function searchAddresses(query: string, sessionToken: string): Promise<AutocompleteResult> {
  const params = new URLSearchParams({ mode: "search", query, sessionToken });
  return payload<AutocompleteResult>(await fetch(`/api/address-autocomplete?${params.toString()}`, { cache: "no-store" }));
}

export async function resolveAddress(placeId: string, sessionToken: string): Promise<ResolvedAddress> {
  const params = new URLSearchParams({ mode: "resolve", placeId, sessionToken });
  return payload<ResolvedAddress>(await fetch(`/api/address-autocomplete?${params.toString()}`, { cache: "no-store" }));
}

export async function reverseGeocodeCoordinates(latitude: number, longitude: number): Promise<ResolvedAddress> {
  const params = new URLSearchParams({ mode: "reverse", latitude: String(latitude), longitude: String(longitude) });
  return payload<ResolvedAddress>(await fetch(`/api/address-autocomplete?${params.toString()}`, { cache: "no-store" }));
}

export type { AddressSuggestion };
