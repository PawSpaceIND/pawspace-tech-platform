import type { CustomerAccountRecord } from "../customer-account";
import { ApiError, apiRequest, apiSend, friendlyHttpMessage } from "../api-fetch";

export type V2CustomerSession = {
  subjectType: "customer";
  subjectId: string;
  roleCode?: string | null;
  identitySource?: string | null;
  expiresAt?: number | null;
};

export type V2ServiceAvailability = {
  code: string;
  enabled: boolean;
  reason?: string | null;
};

export type V2LoggedInCustomer = {
  customerId: string;
  customerName: string;
  phone: string;
  expiresAt?: number;
};

export type V2OtpChallenge = {
  challengeId: string;
  phone?: string;
  sandboxCode?: string;
  expiresInSeconds?: number;
  sandboxDelivery?: boolean;
  liveSmsDelivered?: boolean;
};

function envelope<T>(body: unknown): { data?: T; error?: string } {
  return body && typeof body === "object" ? (body as { data?: T; error?: string }) : {};
}

/**
 * V2 deliberately consumes backend truth through one client boundary. UI components do not call
 * identity, account, availability or OTP routes directly; this keeps migration to the future typed
 * PawSpace SDK mechanical instead of scattering fetch semantics across screens.
 */
export async function loadV2CustomerSession(): Promise<V2CustomerSession | null> {
  const result = await apiRequest("/api/identity-session", { cache: "no-store" });
  if (result.status === 401) return null;
  const body = envelope<V2CustomerSession>(result.body);
  if (!result.ok) throw new ApiError("http", result.status, body.error || friendlyHttpMessage(result.status), result.body);
  if (!body.data || body.data.subjectType !== "customer" || !body.data.subjectId) return null;
  return body.data;
}

export async function loadV2CustomerAccount(): Promise<CustomerAccountRecord> {
  return apiSend<CustomerAccountRecord>(
    "/api/customer-account",
    { cache: "no-store" },
    "We could not load your PawSpace family right now.",
  );
}

export async function loadV2ServiceAvailability(): Promise<V2ServiceAvailability[]> {
  return apiSend<V2ServiceAvailability[]>(
    "/api/service-availability",
    { cache: "no-store" },
    "We could not confirm service availability right now.",
  );
}

export async function requestV2CustomerOtp(phone: string): Promise<V2OtpChallenge> {
  return apiSend<V2OtpChallenge>(
    "/api/customer-otp",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "request", phone }),
    },
    "We could not send your PawSpace code.",
  );
}

export async function verifyV2CustomerOtp(input: {
  challengeId: string;
  code: string;
  name?: string;
}): Promise<V2LoggedInCustomer> {
  return apiSend<V2LoggedInCustomer>(
    "/api/customer-otp",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "verify",
        challengeId: input.challengeId,
        code: input.code,
        name: input.name || undefined,
        cityId: "blr",
      }),
    },
    "We could not verify your PawSpace code.",
  );
}

export async function updateV2CustomerProfile(input: {
  name: string;
  primaryPhone: string;
  secondaryPhone?: string | null;
  email?: string | null;
  cityId: string;
  idempotencyKey: string;
}): Promise<void> {
  await apiSend<Record<string, unknown>>(
    "/api/customer-account",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update_profile",
        idempotencyKey: input.idempotencyKey,
        profile: {
          name: input.name,
          primaryPhone: input.primaryPhone,
          secondaryPhone: input.secondaryPhone ?? null,
          email: input.email ?? null,
          cityId: input.cityId,
        },
      }),
    },
    "We could not update your PawSpace account.",
  );
}

export async function upsertV2CustomerAddress(input: {
  id?: string;
  label: string;
  line1: string;
  line2?: string | null;
  area?: string | null;
  city: string;
  postalCode?: string | null;
  isDefault?: boolean;
  idempotencyKey: string;
}): Promise<void> {
  await apiSend<Record<string, unknown>>(
    "/api/customer-account",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "upsert_address",
        idempotencyKey: input.idempotencyKey,
        address: {
          id: input.id,
          label: input.label,
          line1: input.line1,
          line2: input.line2 ?? null,
          area: input.area ?? null,
          city: input.city,
          postalCode: input.postalCode ?? null,
          isDefault: input.isDefault ?? true,
        },
      }),
    },
    "We could not save your PawSpace address.",
  );
}

export async function endV2CustomerSession(): Promise<void> {
  await apiSend<{ loggedOut: boolean }>(
    "/api/identity-session",
    { method: "DELETE", headers: { "content-type": "application/json" } },
    "We could not sign you out.",
  );
}
