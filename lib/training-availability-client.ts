import {trainingCalendarWindows} from "./training-calendar-policy";
import type {TrainingQuote, TrainingTrainer} from "./training-commercial-client";
import {previewUatProviders, type UatScheduleRequest} from "./uat-scheduling-client";

export type TrainingScheduleSelection = {
  customerId: string; petIds: string[]; cityId: string; zoneId: string;
  scheduledStart: string; quote: TrainingQuote; cadenceDays?: number; schedulingMode?: "rolling_v1" | "series_v1";
  /** The address the customer is looking at, so preview and reserve never fall back to a remembered one. */
  serviceAddress?: string; servicePincode?: string;
};

export type TrainingScheduleRequest=UatScheduleRequest&{trainingQuoteId:string;trainingSchedulingMode?:"rolling_v1"};
/** Preview and reserve share the quote-bound scheduling mode; legacy callers retain their series. */
export function trainingScheduleRequest(input: TrainingScheduleSelection): TrainingScheduleRequest {
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
  if(input.schedulingMode && quote.schedulingMode && input.schedulingMode !== quote.schedulingMode) throw new Error("Training scheduling mode does not match the current quote. Refresh availability.");
  const rolling = (input.schedulingMode ?? quote.schedulingMode) === "rolling_v1";
  trainingCalendarWindows(input.scheduledStart, rolling ? {...quote,sessions:1} : quote, input.cadenceDays ?? 7);
  return {
    clientRequestId: `training:${quote.quoteId}:${input.customerId}${rolling ? ":rolling_v1" : ""}`,
    trainingQuoteId:quote.quoteId,...(rolling?{trainingSchedulingMode:"rolling_v1" as const}:{}),
    customerId: input.customerId, petIds: [...input.petIds], serviceCode: "dog_training",
    cityId: input.cityId, zoneId: input.zoneId, scheduledStart: input.scheduledStart,
    scheduledEnd: new Date(start + quote.minutesPerSession * 60_000).toISOString(),
    occurrences: rolling || quote.meetAndGreet ? 1 : quote.sessions, cadenceDays: input.cadenceDays ?? 7,
    ...(input.serviceAddress && input.servicePincode ? {serviceAddress: input.serviceAddress, servicePincode: input.servicePincode} : {}),
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

/** Reuse the same calendar builder and scheduler. Choice changes identity; changing a preview ranking does not. */
export function trainingReservationForChoice(input: TrainingScheduleSelection, choice: {mode: "auto" | "specific"; providerId?: string}): TrainingScheduleRequest {
  if (choice.mode !== "auto" && choice.mode !== "specific") throw new Error("Choose how your trainer will be assigned.");
  if (choice.mode === "specific" && !choice.providerId?.trim()) throw new Error("Choose your trainer before reserving.");
  const request = trainingScheduleRequest(input);
  return {...request, clientRequestId: `${request.clientRequestId}:choice:${choice.mode}${choice.mode === "specific" ? `:${encodeURIComponent(choice.providerId!)}` : ""}`,
    providerSelection: choice.mode, ...(choice.mode === "specific" ? {preferredProviderId: choice.providerId} : {})};
}
