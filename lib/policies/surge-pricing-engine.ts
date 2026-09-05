export type SurgeService = "mobile_grooming" | "boarding";
export type SurgeAvailability = "available" | "suspended_for_safety" | "neutral_fallback";

export interface ZoneDemandSignal {
  zoneId: string;
  openDemand: number;
  activeProviders: number;
  sampleAgeSeconds: number;
}

export interface WeatherSignal {
  severity: number;
  precipitationProbability: number;
  heatIndexCelsius?: number | null;
  forecastAgeSeconds: number;
}

export interface ProviderCapacitySignal {
  utilization: number;
  availableSlots: number;
  totalSlots: number;
  sampleAgeSeconds: number;
}

export interface SurgePricingInput {
  service: SurgeService;
  basePricePaise: number;
  zone: ZoneDemandSignal;
  weather: WeatherSignal;
  capacity: ProviderCapacitySignal;
  policyVersion?: string;
}

export interface SurgeFactorBreakdown {
  zoneDensity: number;
  weather: number;
  capacityUtilization: number;
  uncappedMultiplier: number;
  cappedMultiplier: number;
}

export interface SurgePricingQuote {
  service: SurgeService;
  zoneId: string;
  basePricePaise: number;
  quotedPricePaise: number;
  multiplier: number;
  availability: SurgeAvailability;
  factors: SurgeFactorBreakdown;
  reasonCodes: string[];
  policyVersion: string;
}

const POLICY_VERSION = "v2-surge-pricing-2026-09-04";
const MAX_SIGNAL_AGE_SECONDS = 15 * 60;
const SERVICE_CAPS: Readonly<Record<SurgeService, number>> = {
  mobile_grooming: 1.5,
  boarding: 1.4,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function requireNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
}

function signalsFresh(input: SurgePricingInput): boolean {
  return input.zone.sampleAgeSeconds <= MAX_SIGNAL_AGE_SECONDS
    && input.weather.forecastAgeSeconds <= MAX_SIGNAL_AGE_SECONDS
    && input.capacity.sampleAgeSeconds <= MAX_SIGNAL_AGE_SECONDS;
}

function zoneDensityFactor(zone: ZoneDemandSignal): number {
  const providers = Math.max(1, Math.floor(zone.activeProviders));
  const demandPerProvider = Math.max(0, zone.openDemand) / providers;
  if (demandPerProvider <= 1) return 1;
  return 1 + clamp((demandPerProvider - 1) / 4, 0, 1) * 0.18;
}

function weatherFactor(weather: WeatherSignal): number {
  const severity = clamp(weather.severity, 0, 1);
  const precipitation = clamp(weather.precipitationProbability, 0, 1);
  const heatPressure = weather.heatIndexCelsius == null
    ? 0
    : clamp((weather.heatIndexCelsius - 32) / 12, 0, 1);
  const pressure = Math.max(severity, precipitation * 0.7, heatPressure * 0.6);
  return 1 + pressure * 0.12;
}

function capacityFactor(capacity: ProviderCapacitySignal): number {
  const utilization = clamp(capacity.utilization, 0, 1);
  if (utilization <= 0.65) return 1;
  return 1 + ((utilization - 0.65) / 0.35) * 0.2;
}

function roundedMultiplier(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateSurgePricing(input: SurgePricingInput): SurgePricingQuote {
  requireNonNegative(input.basePricePaise, "basePricePaise");
  requireNonNegative(input.zone.openDemand, "zone.openDemand");
  requireNonNegative(input.zone.activeProviders, "zone.activeProviders");
  requireNonNegative(input.zone.sampleAgeSeconds, "zone.sampleAgeSeconds");
  requireNonNegative(input.weather.forecastAgeSeconds, "weather.forecastAgeSeconds");
  requireNonNegative(input.weather.severity, "weather.severity");
  requireNonNegative(input.weather.precipitationProbability, "weather.precipitationProbability");
  requireNonNegative(input.capacity.utilization, "capacity.utilization");
  requireNonNegative(input.capacity.availableSlots, "capacity.availableSlots");
  requireNonNegative(input.capacity.totalSlots, "capacity.totalSlots");
  requireNonNegative(input.capacity.sampleAgeSeconds, "capacity.sampleAgeSeconds");
  if (input.capacity.totalSlots > 0 && input.capacity.availableSlots > input.capacity.totalSlots) {
    throw new Error("capacity.availableSlots cannot exceed capacity.totalSlots");
  }

  const policyVersion = input.policyVersion?.trim() || POLICY_VERSION;
  const neutralFactors: SurgeFactorBreakdown = {
    zoneDensity: 1,
    weather: 1,
    capacityUtilization: 1,
    uncappedMultiplier: 1,
    cappedMultiplier: 1,
  };

  if (!signalsFresh(input)) {
    return {
      service: input.service,
      zoneId: input.zone.zoneId,
      basePricePaise: Math.round(input.basePricePaise),
      quotedPricePaise: Math.round(input.basePricePaise),
      multiplier: 1,
      availability: "neutral_fallback",
      factors: neutralFactors,
      reasonCodes: ["stale_realtime_signal", "surge_disabled_fail_safe"],
      policyVersion,
    };
  }

  if (clamp(input.weather.severity, 0, 1) >= 0.9) {
    return {
      service: input.service,
      zoneId: input.zone.zoneId,
      basePricePaise: Math.round(input.basePricePaise),
      quotedPricePaise: Math.round(input.basePricePaise),
      multiplier: 1,
      availability: "suspended_for_safety",
      factors: neutralFactors,
      reasonCodes: ["extreme_weather_safety_gate", "pricing_suspended_not_surge"],
      policyVersion,
    };
  }

  const density = zoneDensityFactor(input.zone);
  const weather = weatherFactor(input.weather);
  const capacity = capacityFactor(input.capacity);
  const uncapped = density * weather * capacity;
  const capped = clamp(uncapped, 1, SERVICE_CAPS[input.service]);
  const multiplier = roundedMultiplier(capped);
  const reasonCodes = [
    density > 1 ? "hyperlocal_demand_density" : "normal_zone_density",
    weather > 1 ? "weather_operating_pressure" : "normal_weather",
    capacity > 1 ? "high_provider_utilization" : "normal_provider_capacity",
  ];
  if (uncapped > SERVICE_CAPS[input.service]) reasonCodes.push("service_surge_cap_applied");

  return {
    service: input.service,
    zoneId: input.zone.zoneId,
    basePricePaise: Math.round(input.basePricePaise),
    quotedPricePaise: Math.round(input.basePricePaise * multiplier),
    multiplier,
    availability: "available",
    factors: {
      zoneDensity: roundedMultiplier(density),
      weather: roundedMultiplier(weather),
      capacityUtilization: roundedMultiplier(capacity),
      uncappedMultiplier: roundedMultiplier(uncapped),
      cappedMultiplier: multiplier,
    },
    reasonCodes,
    policyVersion,
  };
}
