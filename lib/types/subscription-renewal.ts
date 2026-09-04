export type UnifiedRenewalJourneyState =
  | "message_sent"
  | "link_clicked"
  | "payment_verified"
  | "entitlement_active";

export interface UnifiedRenewalJourney {
  householdId: string;
  entitlementId?: string | null;
  serviceCode: string;
  state: UnifiedRenewalJourneyState;
  updatedAt: number;
}

export const unifiedRenewalJourneyTransitions: Readonly<
  Record<UnifiedRenewalJourneyState, readonly UnifiedRenewalJourneyState[]>
> = {
  message_sent: ["link_clicked"],
  link_clicked: ["payment_verified"],
  payment_verified: ["entitlement_active"],
  entitlement_active: [],
};
