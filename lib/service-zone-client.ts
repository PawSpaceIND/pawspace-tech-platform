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

export async function resolveServiceCoverage(pincodeInput: string, signal?: AbortSignal): Promise<ResolvedServiceCoverage> {
  const pincode = pincodeInput.replace(/\D/g, "").slice(0, 6);
  if (pincode.length !== 6) throw new Error("Enter a valid six-digit service PIN code.");

  const response = await fetch(`/api/service-zone?pincode=${encodeURIComponent(pincode)}`, { cache: "no-store", signal });
  const body = await response.json() as {
    data?: {
      zone?: { zoneId?: string; zoneName?: string; description?: string; color?: string; serviceAvailable?: boolean };
      assignment?: { pincode?: string; zoneId?: string; cityId?: string; city?: string; area?: string };
    };
    error?: string;
  };
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
