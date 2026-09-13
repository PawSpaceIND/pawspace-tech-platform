import type { AddressSuggestion, AutocompleteResult, ResolvedAddress } from "./address-autocomplete";

async function fetchWithDeadline(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Address lookup timed out");
    throw error;
  } finally { clearTimeout(timer); }
}

async function payload<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { data?: T; error?: string };
  if (!response.ok) throw new Error(body.error || "Address lookup failed");
  return body.data as T;
}

export async function searchAddresses(query: string, sessionToken: string): Promise<AutocompleteResult> {
  const params = new URLSearchParams({ mode: "search", query, sessionToken });
  return payload<AutocompleteResult>(await fetchWithDeadline(`/api/address-autocomplete?${params.toString()}`, { cache: "no-store" }));
}

export async function resolveAddress(placeId: string, sessionToken: string): Promise<ResolvedAddress> {
  const params = new URLSearchParams({ mode: "resolve", placeId, sessionToken });
  return payload<ResolvedAddress>(await fetchWithDeadline(`/api/address-autocomplete?${params.toString()}`, { cache: "no-store" }));
}

export async function reverseGeocodeCoordinates(latitude: number, longitude: number): Promise<ResolvedAddress> {
  const params = new URLSearchParams({ mode: "reverse", latitude: String(latitude), longitude: String(longitude) });
  return payload<ResolvedAddress>(await fetchWithDeadline(`/api/address-autocomplete?${params.toString()}`, { cache: "no-store" }));
}

export type { AddressSuggestion };
