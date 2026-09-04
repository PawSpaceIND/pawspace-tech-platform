export type PromoEligibilityDecision =
  | { eligible: true; reason: "first_seen_pair" | "known_pair" }
  | {
      eligible: false;
      reason:
        | "invalid_identity"
        | "device_linked_to_another_household"
        | "household_linked_to_another_device";
    };

export interface PromoVelocityStore {
  getHouseholdForDevice(deviceFingerprint: string): string | null;
  getDeviceForHousehold(householdId: string): string | null;
  linkHouseholdAndDevice(householdId: string, deviceFingerprint: string): void;
}

class InMemoryPromoVelocityStore implements PromoVelocityStore {
  private readonly householdByDevice = new Map<string, string>();
  private readonly deviceByHousehold = new Map<string, string>();

  getHouseholdForDevice(deviceFingerprint: string): string | null {
    return this.householdByDevice.get(deviceFingerprint) ?? null;
  }

  getDeviceForHousehold(householdId: string): string | null {
    return this.deviceByHousehold.get(householdId) ?? null;
  }

  linkHouseholdAndDevice(householdId: string, deviceFingerprint: string): void {
    this.householdByDevice.set(deviceFingerprint, householdId);
    this.deviceByHousehold.set(householdId, deviceFingerprint);
  }
}

let velocityStore: PromoVelocityStore = new InMemoryPromoVelocityStore();

export function configurePromoVelocityStore(store: PromoVelocityStore): void {
  velocityStore = store;
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

export function evaluatePromoEligibility(
  householdId: string,
  deviceFingerprint: string,
): PromoEligibilityDecision {
  const normalizedHouseholdId = normalizeIdentity(householdId);
  const normalizedFingerprint = normalizeIdentity(deviceFingerprint);

  if (!normalizedHouseholdId || !normalizedFingerprint) {
    return { eligible: false, reason: "invalid_identity" };
  }

  const householdForDevice = velocityStore.getHouseholdForDevice(
    normalizedFingerprint,
  );
  if (
    householdForDevice !== null &&
    householdForDevice !== normalizedHouseholdId
  ) {
    return {
      eligible: false,
      reason: "device_linked_to_another_household",
    };
  }

  const deviceForHousehold = velocityStore.getDeviceForHousehold(
    normalizedHouseholdId,
  );
  if (
    deviceForHousehold !== null &&
    deviceForHousehold !== normalizedFingerprint
  ) {
    return {
      eligible: false,
      reason: "household_linked_to_another_device",
    };
  }

  if (
    householdForDevice === normalizedHouseholdId &&
    deviceForHousehold === normalizedFingerprint
  ) {
    return { eligible: true, reason: "known_pair" };
  }

  velocityStore.linkHouseholdAndDevice(
    normalizedHouseholdId,
    normalizedFingerprint,
  );
  return { eligible: true, reason: "first_seen_pair" };
}
