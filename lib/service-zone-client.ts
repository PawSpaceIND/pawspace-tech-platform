// @ts-expect-error Node 22 strip-types requires the explicit .ts extension at runtime.
import { fetchOrExplain, readJsonBody, unreadableAnswerMessage } from "./safe-json-response.ts";
// @ts-expect-error Node 22 strip-types requires the explicit .ts extension at runtime.
import { validateIndianPincode } from "./pincode-validation.ts";

export type ResolvedServiceZone = {
  zoneId: string;
  zoneName: string;
  description: string;
  color: string;
  serviceAvailable: boolean;
};

export type ResolvedServiceCoverage = {
  cityId: string;
  city: string;
  zoneId: string;
  zoneName: string;
  pincode: string;
  area: string;
  zone: ResolvedServiceZone;
};

/**
 * The server's answer that PawSpace does not serve a PIN: no zone for it (404), a city that is not open (409)
 * or a zone that is not available. A network, server or parse failure stays a plain Error, so a caller can
 * tell "not served" from "could not check". The message is the same either way.
 */
export class ServiceCoverageRefusal extends Error {
  constructor(message: string) { super(message); this.name = "ServiceCoverageRefusal"; }
}

export function cityIdFromZoneId(zoneId: string): string {
  const cityId = zoneId.trim().split("-")[0]?.toLowerCase() || "";
  if (!/^[a-z0-9]{2,16}$/.test(cityId)) throw new Error("Service zone is missing a valid city identifier.");
  return cityId;
}

/**
 * The raw-PIN boundary every customer coverage caller uses (lib/pincode-validation.ts): outer whitespace is trimmed
 * and nothing else. Letters, inner spaces or punctuation and anything longer than six digits are refused as typed;
 * they are never stripped or truncated into a different, serviceable PIN.
 */
export const SERVICE_PIN_MISSING = "Enter a valid six-digit service PIN code for this address.";
export const SERVICE_PIN_MALFORMED = "Enter a valid six-digit service PIN code: six digits only, with no spaces or other characters.";
export class ServicePincodeInputError extends Error {
  constructor(message: string) { super(message); this.name = "ServicePincodeInputError"; }
}
export function strictServicePincode(raw: unknown): { ok: true; pincode: string } | { ok: false; reason: "missing" | "malformed"; message: string } {
  const checked = validateIndianPincode(typeof raw === "string" ? raw : raw == null ? null : String(raw));
  if (checked.ok) return checked;
  return { ok: false, reason: checked.reason, message: checked.reason === "missing" ? SERVICE_PIN_MISSING : SERVICE_PIN_MALFORMED };
}

export async function resolveServiceCoverage(pincodeInput: string, signal?: AbortSignal): Promise<ResolvedServiceCoverage> {
  // Validated BEFORE any fetch: a malformed PIN never reaches the coverage API.
  const checked = strictServicePincode(pincodeInput);
  if (!checked.ok) throw new ServicePincodeInputError(checked.message);
  const pincode = checked.pincode;

  const response = await fetchOrExplain(`/api/service-zone?pincode=${encodeURIComponent(pincode)}`, { cache: "no-store", signal }, "check this PIN");
  const body = await readJsonBody<{
    data?: {
      zone?: { zoneId?: string; zoneName?: string; description?: string; color?: string; serviceAvailable?: boolean };
      assignment?: { pincode?: string; zoneId?: string; cityId?: string; city?: string; area?: string };
    };
    error?: string;
  }>(response);
  // A gateway page or an empty body is "could not check", never a JSON parse error and never "not served".
  if (!body) throw new Error(unreadableAnswerMessage(response.status, "check this PIN"));
  const assignment = body.data?.assignment;
  const zone = body.data?.zone;
  if (!response.ok || !assignment?.zoneId || !zone?.serviceAvailable) {
    const message = body.error || `PIN code ${pincode} is outside the currently enabled service area.`;
    const refused = response.status === 404 || response.status === 409 || (response.ok && Boolean(assignment?.zoneId) && zone?.serviceAvailable === false);
    throw refused ? new ServiceCoverageRefusal(message) : new Error(message);
  }
  const cityId = String(assignment.cityId || cityIdFromZoneId(assignment.zoneId)).trim().toLowerCase();
  const resolvedZoneId = zone.zoneId || assignment.zoneId;
  return {
    cityId,
    city: assignment.city || "",
    zoneId: assignment.zoneId,
    zoneName: zone.zoneName || assignment.zoneId,
    pincode: assignment.pincode || pincode,
    area: assignment.area || "",
    zone: {
      zoneId: resolvedZoneId,
      zoneName: zone.zoneName || resolvedZoneId,
      description: zone.description || "",
      color: zone.color || "var(--ds-primary-500)",
      serviceAvailable: zone.serviceAvailable === true,
    },
  };
}
