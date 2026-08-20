export type ResolvedServiceCoverage = {
  cityId: string;
  city: string;
  zoneId: string;
  zoneName: string;
  pincode: string;
  area: string;
};

export async function resolveServiceCoverage(pincodeInput: string): Promise<ResolvedServiceCoverage> {
  const pincode = pincodeInput.replace(/\D/g, "").slice(0, 6);
  if (pincode.length !== 6) throw new Error("Enter a valid six-digit service PIN code.");

  const response = await fetch(`/api/service-zone?pincode=${encodeURIComponent(pincode)}`, { cache: "no-store" });
  const body = await response.json() as {
    data?: {
      zone?: { zoneId?: string; zoneName?: string; serviceAvailable?: boolean };
      assignment?: { pincode?: string; zoneId?: string; city?: string; area?: string };
    };
    error?: string;
  };
  const assignment = body.data?.assignment;
  const zone = body.data?.zone;
  if (!response.ok || !assignment?.zoneId || !zone?.serviceAvailable) {
    throw new Error(body.error || `PIN code ${pincode} is outside the currently enabled service area.`);
  }
  if (assignment.city !== "Bengaluru") {
    throw new Error(`${assignment.city || "This city"} is not enabled for customer bookings yet.`);
  }
  return {
    cityId: "blr",
    city: assignment.city,
    zoneId: assignment.zoneId,
    zoneName: zone.zoneName || assignment.zoneId,
    pincode: assignment.pincode || pincode,
    area: assignment.area || "",
  };
}
