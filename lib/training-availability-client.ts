import {trainingCalendarWindows} from "./training-calendar-policy";
import type {TrainingQuote, TrainingTrainer} from "./training-commercial-client";
import {previewUatProviders, type UatScheduleRequest} from "./uat-scheduling-client";

export type TrainingScheduleSelection = {
  customerId: string; petIds: string[]; cityId: string; zoneId: string;
  scheduledStart: string; quote: TrainingQuote; cadenceDays?: number;
};

/** Preview and reserve describe exactly the same programme, not only session one. */
export function trainingScheduleRequest(input: TrainingScheduleSelection): UatScheduleRequest {
  const {quote} = input;
  const start = Date.parse(input.scheduledStart);
  if (!input.customerId || !input.cityId || !input.zoneId || input.petIds.length === 0 ||
      input.petIds.length !== quote.petCount || !Number.isFinite(start) ||
      !Number.isFinite(quote.minutesPerSession) || quote.minutesPerSession <= 0 ||
      !Number.isInteger(quote.sessions) || quote.sessions < 1) {
    throw new Error("Select your pets, programme and session date before checking availability.");
  }
  if (!Number.isFinite(quote.expiresAt) || quote.expiresAt <= Date.now()) {
    throw new Error("Your Training quote expired. Refresh availability before continuing.");
  }
  trainingCalendarWindows(input.scheduledStart, quote, input.cadenceDays ?? 7);
  return {
    clientRequestId: `training:${quote.quoteId}:${input.customerId}`,
    customerId: input.customerId, petIds: [...input.petIds], serviceCode: "dog_training",
    cityId: input.cityId, zoneId: input.zoneId, scheduledStart: input.scheduledStart,
    scheduledEnd: new Date(start + quote.minutesPerSession * 60_000).toISOString(),
    occurrences: quote.meetAndGreet ? 1 : quote.sessions, cadenceDays: input.cadenceDays ?? 7,
  };
}

export async function loadAvailableTrainingTrainers(
  selection: TrainingScheduleSelection, roster: TrainingTrainer[], signal?: AbortSignal,
): Promise<TrainingTrainer[]> {
  const request = trainingScheduleRequest(selection);
  // Remote D1 programme checks took 39s in the failed deployed run. Other services keep 15s.
  const preview = await previewUatProviders(request, {timeoutMs: 60_000, signal});
  const sameInstant = (a: string, b: string) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
  if (preview.availabilityChecked !== true || preview.reserved !== false ||
      preview.cityId !== request.cityId || preview.zoneId !== request.zoneId ||
      !sameInstant(preview.scheduledStart, request.scheduledStart) ||
      !sameInstant(preview.scheduledEnd, request.scheduledEnd) ||
      !Array.isArray(preview.occurrences) || preview.occurrences.length !== request.occurrences ||
      preview.occurrences.some((session, index) =>
        !sameInstant(session.start, new Date(Date.parse(request.scheduledStart) + index * (request.cadenceDays ?? 7) * 86_400_000).toISOString()) ||
        !sameInstant(session.end, new Date(Date.parse(request.scheduledEnd) + index * (request.cadenceDays ?? 7) * 86_400_000).toISOString()))) {
    throw new Error("Training availability does not match this programme. Refresh availability.");
  }
  const byId = new Map(roster.map(provider => [provider.id, provider]));
  return preview.providers.flatMap(provider => {
    const eligible = byId.get(provider.id);
    return eligible ? [{...eligible, name: provider.name, model: provider.model}] : [];
  });
}
