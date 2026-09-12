export type CollarTelemetryEnvelope = {
  deviceId: string;
  petId: string;
  observedAt: string;
  signalType: "location" | "activity" | "vitals" | "battery";
  payload: unknown;
};

export interface CollarTelemetryChannel {
  ingest(event: CollarTelemetryEnvelope): Promise<{ accepted: boolean; reason: string }>;
}

export const disabledCollarTelemetryChannel: CollarTelemetryChannel = {
  async ingest() {
    return { accepted: false, reason: "phase3_iot_not_enabled" };
  },
};
