export type OfflineHealthFlagSeverity = "info" | "watch" | "urgent";

export interface ProviderOfflineHealthFlag {
  code: string;
  severity: OfflineHealthFlagSeverity;
  summary: string;
  providerInstruction?: string;
  updatedAt: string;
}

export interface ProviderOfflinePet {
  petId: string;
  name: string;
  species: "dog" | "cat" | "other";
  healthFlags: ProviderOfflineHealthFlag[];
  allergies: string[];
  medicationInstructions: string[];
  handlingNotes?: string;
}

export interface ProviderOfflineAccessInstructions {
  entryMethod:
    | "customer_handoff"
    | "front_desk"
    | "key"
    | "lockbox"
    | "digital_code"
    | "other";
  instructions: string[];
  parkingNotes?: string;
  buildingNotes?: string;
  encryptedAccessSecret?: string;
}

export interface ProviderOfflineEmergencyContact {
  name: string;
  relationship: "customer" | "alternate_contact" | "veterinarian" | "pawspace";
  phone: string;
  priority: number;
}

export interface ProviderOfflineJob {
  jobId: string;
  serviceType: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  serviceAddressSummary: string;
  pets: ProviderOfflinePet[];
  accessInstructions: ProviderOfflineAccessInstructions;
  emergencyContacts: ProviderOfflineEmergencyContact[];
}

export interface ProviderDayCache {
  schemaVersion: "v2-provider-day-cache-1";
  providerId: string;
  serviceDate: string;
  generatedAt: string;
  expiresAt: string;
  jobs: ProviderOfflineJob[];
  security: {
    encryptedAtRest: true;
    purgeAfter: string;
  };
}
