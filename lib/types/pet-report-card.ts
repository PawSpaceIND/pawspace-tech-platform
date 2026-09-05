export type HealthFlagSeverity = "info" | "watch" | "urgent";

export interface ServiceProofGpsPoint {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  capturedAt: string;
}

export interface BathroomBreakObservation {
  kind: "urination" | "defecation";
  occurredAt: string;
  notes?: string;
}

export type TemperamentObservation =
  | "calm"
  | "playful"
  | "anxious"
  | "reactive"
  | "tired"
  | "other";

export interface ServiceHealthFlag {
  code: string;
  severity: HealthFlagSeverity;
  observedAt: string;
  notes?: string;
}

export interface PetStructuredReport {
  bathroomBreaks: BathroomBreakObservation[];
  temperament: TemperamentObservation[];
  healthFlags: ServiceHealthFlag[];
  providerNotes?: string;
}

export interface PetReportCardPayload {
  jobId: string;
  providerId: string;
  checkInGps: ServiceProofGpsPoint;
  checkOutGps: ServiceProofGpsPoint;
  mediaUrls: string[];
  structuredReport: PetStructuredReport;
}
