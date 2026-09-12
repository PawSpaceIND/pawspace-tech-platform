export type AmbientVisionObservation = {
  sourceId: string;
  bookingId?: string;
  petId?: string;
  observedAt: string;
  mediaRef: string;
};

export interface AmbientVisionDispatcher {
  evaluate(observation: AmbientVisionObservation): Promise<{ dispatched: boolean; reason: string }>;
}

export const disabledAmbientVisionDispatcher: AmbientVisionDispatcher = {
  async evaluate() {
    return { dispatched: false, reason: "phase3_vision_not_enabled" };
  },
};
