import type { CustomerAccountRecord } from "./customer-account";
import type { PetProfile } from "./pet-profile-options";

export type CustomerPet = CustomerAccountRecord["pets"][number];
export type PetProfileInput = {
  id?: string;
  name: string;
  species: string;
  breed?: string | null;
  vaccinationStatus: string;
  ageYears?: number | null;
  weightKg?: number | null;
  profile?: PetProfile;
};

async function payload<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!response.ok || body.data === undefined) throw new Error(body.error || fallback);
  return body.data;
}

/** The customer identity is resolved server-side from the platform session (with ownership checks);
 *  customerId is passed only as an explicit hint for signed-in components. */
export async function loadCustomerAccount(customerId?: string) {
  const query = customerId ? `?customerId=${encodeURIComponent(customerId)}` : "";
  const response = await fetch(`/api/customer-account${query}`, { cache: "no-store" });
  return payload<CustomerAccountRecord>(response, "Unable to load your account");
}

export async function loadCustomerPets(customerId?: string): Promise<CustomerPet[]> {
  const account = await loadCustomerAccount(customerId);
  return account.pets;
}

export async function upsertCustomerPet(input: { customerId?: string; pet: PetProfileInput }) {
  const response = await fetch("/api/customer-account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: input.customerId,
      action: "upsert_pet",
      idempotencyKey: `pet-manager:${crypto.randomUUID()}`,
      pet: input.pet,
    }),
  });
  return payload<{ entityId: string; duplicatePrevented?: boolean }>(response, "Unable to save the pet");
}
