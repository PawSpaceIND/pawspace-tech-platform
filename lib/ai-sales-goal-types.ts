export type AiSalesTargetType =
  | "lead_generated"
  | "subscription_renewal"
  | "training_closure"
  | "booking_conversion";

export type AiSalesChannel = "voice" | "whatsapp";
export type QuotaPressure = "steady" | "watch" | "urgent";

export type AiSalesTarget = {
  id: string;
  targetDate: string;
  targetType: AiSalesTargetType;
  serviceCode: string | null;
  cityId: string | null;
  timezone: string;
  dailyGoal: number;
  achievedCount: number;
  maxDiscountBps: number;
  minimumMarginBps: number;
  freeUpgradeCodes: string[];
  authorizedChannels: AiSalesChannel[];
  maxContactsPerDay: number;
  offerPolicyVersion: string;
  promptPolicyVersion: string;
  startsAt: number;
  endsAt: number;
};

export type OfferEnvelope = {
  targetId: string;
  policyVersion: string;
  maxDiscountBps: number;
  minimumMarginBps: number;
  freeUpgradeCodes: string[];
  expiresAt: number;
};

export type SalesPromptContext = {
  targetId: string;
  targetType: AiSalesTargetType;
  dailyGoal: number;
  achievedCount: number;
  remaining: number;
  pressure: QuotaPressure;
  channel: AiSalesChannel;
  offer: OfferEnvelope;
};
