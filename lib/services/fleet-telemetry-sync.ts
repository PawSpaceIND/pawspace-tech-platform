export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface FleetTelemetryPoint extends GeoPoint {
  vehicleId: string;
  capturedAt: number;
  accuracyMeters?: number | null;
  headingDegrees?: number | null;
  speedKph?: number | null;
}

export interface FleetRouteStop extends GeoPoint {
  stopId: string;
  customerId: string;
  jobId: string;
  serviceDurationMinutes: number;
  earliestArrivalAt?: number | null;
  latestArrivalAt?: number | null;
  priorEtaAt?: number | null;
}

export interface OptimizedFleetStop extends FleetRouteStop {
  sequence: number;
  distanceFromPreviousKm: number;
  etaAt: number;
  departureAt: number;
}

export interface FleetRoutePlan {
  vehicleId: string;
  generatedAt: number;
  routeVersion: string;
  totalDistanceKm: number;
  stops: OptimizedFleetStop[];
}

export interface CustomerEtaNotification {
  customerId: string;
  jobId: string;
  stopId: string;
  vehicleId: string;
  etaAt: number;
  etaWindowMinutes: number;
  routeVersion: string;
  reason: "initial_eta" | "eta_changed" | "approaching";
  dedupeKey: string;
}

export interface EtaNotificationPublisher {
  publish(notification: CustomerEtaNotification): Promise<void>;
}

export interface EtaPublishResult {
  published: number;
  failed: number;
}

export interface FleetTelemetrySyncInput {
  telemetry: FleetTelemetryPoint;
  stops: FleetRouteStop[];
  now: number;
  fallbackAverageSpeedKph?: number;
  maxTelemetryAgeSeconds?: number;
  etaChangeNotifyMinutes?: number;
  approachingNotifyMinutes?: number;
}

export interface FleetTelemetrySyncResult {
  status: "synced" | "telemetry_stale" | "invalid_telemetry";
  route: FleetRoutePlan | null;
  notifications: CustomerEtaNotification[];
  policyVersion: string;
}

const POLICY_VERSION = "v2-fleet-telemetry-2026-09-04";
const EARTH_RADIUS_KM = 6_371;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function validCoordinate(point: GeoPoint): boolean {
  return Number.isFinite(point.latitude)
    && Number.isFinite(point.longitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && point.longitude >= -180
    && point.longitude <= 180;
}

function radians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

export function haversineDistanceKm(from: GeoPoint, to: GeoPoint): number {
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const fromLatitude = radians(from.latitude);
  const toLatitude = radians(to.latitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const centralAngle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * centralAngle;
}

function routeDistance(start: GeoPoint, stops: FleetRouteStop[]): number {
  let total = 0;
  let previous = start;
  for (const stop of stops) {
    total += haversineDistanceKm(previous, stop);
    previous = stop;
  }
  return total;
}

function nearestNeighbor(start: GeoPoint, stops: FleetRouteStop[]): FleetRouteStop[] {
  const remaining = [...stops];
  const ordered: FleetRouteStop[] = [];
  let current = start;
  while (remaining.length > 0) {
    let selectedIndex = 0;
    let selectedDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (!candidate) continue;
      const distance = haversineDistanceKm(current, candidate);
      const deadlinePenalty = candidate.latestArrivalAt == null ? 0 : candidate.latestArrivalAt / 1e15;
      const score = distance + deadlinePenalty;
      if (score < selectedDistance) {
        selectedDistance = score;
        selectedIndex = index;
      }
    }
    const [next] = remaining.splice(selectedIndex, 1);
    ordered.push(next);
    current = next;
  }
  return ordered;
}

function twoOpt(start: GeoPoint, route: FleetRouteStop[]): FleetRouteStop[] {
  let best = [...route];
  let bestDistance = routeDistance(start, best);
  for (let pass = 0; pass < 2; pass += 1) {
    let improved = false;
    for (let left = 0; left < best.length - 1; left += 1) {
      for (let right = left + 1; right < best.length; right += 1) {
        const candidate = [
          ...best.slice(0, left),
          ...best.slice(left, right + 1).reverse(),
          ...best.slice(right + 1),
        ];
        const candidateDistance = routeDistance(start, candidate);
        if (candidateDistance + 0.001 < bestDistance) {
          best = candidate;
          bestDistance = candidateDistance;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

function travelMinutes(distanceKm: number, speedKph: number): number {
  return (distanceKm / Math.max(5, speedKph)) * 60;
}

export function optimizeFleetRoute(
  telemetry: FleetTelemetryPoint,
  stops: FleetRouteStop[],
  now: number,
  fallbackAverageSpeedKph = 24,
): FleetRoutePlan {
  const ordered = twoOpt(telemetry, nearestNeighbor(telemetry, stops));
  const speedKph = clamp(
    telemetry.speedKph != null && telemetry.speedKph >= 5
      ? telemetry.speedKph
      : fallbackAverageSpeedKph,
    8,
    60,
  );
  let previous: GeoPoint = telemetry;
  let cursor = now;
  let totalDistanceKm = 0;

  const optimized = ordered.map((stop, index): OptimizedFleetStop => {
    const distance = haversineDistanceKm(previous, stop);
    totalDistanceKm += distance;
    const arrival = cursor + travelMinutes(distance, speedKph) * 60_000;
    const etaAt = stop.earliestArrivalAt == null ? arrival : Math.max(arrival, stop.earliestArrivalAt);
    const departureAt = etaAt + Math.max(0, stop.serviceDurationMinutes) * 60_000;
    previous = stop;
    cursor = departureAt;
    return {
      ...stop,
      sequence: index + 1,
      distanceFromPreviousKm: Math.round(distance * 100) / 100,
      etaAt: Math.round(etaAt),
      departureAt: Math.round(departureAt),
    };
  });

  const routeSeed = optimized.map((stop) => `${stop.stopId}:${stop.sequence}:${stop.etaAt}`).join("|");
  return {
    vehicleId: telemetry.vehicleId,
    generatedAt: now,
    routeVersion: `${telemetry.vehicleId}:${telemetry.capturedAt}:${routeSeed}`,
    totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
    stops: optimized,
  };
}

export function buildCustomerEtaNotifications(
  route: FleetRoutePlan,
  now: number,
  etaChangeNotifyMinutes = 5,
  approachingNotifyMinutes = 30,
): CustomerEtaNotification[] {
  const notifications: CustomerEtaNotification[] = [];
  for (const stop of route.stops) {
    const minutesUntilEta = (stop.etaAt - now) / 60_000;
    const changedMinutes = stop.priorEtaAt == null
      ? Number.POSITIVE_INFINITY
      : Math.abs(stop.etaAt - stop.priorEtaAt) / 60_000;
    let reason: CustomerEtaNotification["reason"] | null = null;
    if (stop.priorEtaAt == null) reason = "initial_eta";
    else if (minutesUntilEta <= approachingNotifyMinutes && minutesUntilEta >= 0) reason = "approaching";
    else if (changedMinutes >= etaChangeNotifyMinutes) reason = "eta_changed";
    if (!reason) continue;

    notifications.push({
      customerId: stop.customerId,
      jobId: stop.jobId,
      stopId: stop.stopId,
      vehicleId: route.vehicleId,
      etaAt: stop.etaAt,
      etaWindowMinutes: Math.max(10, Math.round(8 + stop.distanceFromPreviousKm * 1.5)),
      routeVersion: route.routeVersion,
      reason,
      dedupeKey: `${stop.jobId}:${reason}:${Math.floor(stop.etaAt / 300_000)}`,
    });
  }
  return notifications;
}

export function syncFleetTelemetry(input: FleetTelemetrySyncInput): FleetTelemetrySyncResult {
  const maxAgeSeconds = input.maxTelemetryAgeSeconds ?? 120;
  if (!validCoordinate(input.telemetry) || input.stops.some((stop) => !validCoordinate(stop))) {
    return { status: "invalid_telemetry", route: null, notifications: [], policyVersion: POLICY_VERSION };
  }
  if (!Number.isFinite(input.now) || !Number.isFinite(input.telemetry.capturedAt)) {
    return { status: "invalid_telemetry", route: null, notifications: [], policyVersion: POLICY_VERSION };
  }
  const ageSeconds = Math.max(0, (input.now - input.telemetry.capturedAt) / 1_000);
  if (ageSeconds > maxAgeSeconds) {
    return { status: "telemetry_stale", route: null, notifications: [], policyVersion: POLICY_VERSION };
  }

  const route = optimizeFleetRoute(
    input.telemetry,
    input.stops,
    input.now,
    input.fallbackAverageSpeedKph,
  );
  return {
    status: "synced",
    route,
    notifications: buildCustomerEtaNotifications(
      route,
      input.now,
      input.etaChangeNotifyMinutes,
      input.approachingNotifyMinutes,
    ),
    policyVersion: POLICY_VERSION,
  };
}

export async function publishCustomerEtaNotifications(
  notifications: CustomerEtaNotification[],
  publisher: EtaNotificationPublisher,
): Promise<EtaPublishResult> {
  let published = 0;
  let failed = 0;
  for (const notification of notifications) {
    try {
      await publisher.publish(notification);
      published += 1;
    } catch {
      failed += 1;
    }
  }
  return { published, failed };
}
