import { Geolocation, type Position, type PermissionStatus } from "@capacitor/geolocation";
import { Capacitor } from "@capacitor/core";

export interface PawSpaceCoordinates {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp: number;
}

export async function checkGeolocationPermission(): Promise<PermissionStatus> {
  if (Capacitor.isNativePlatform()) {
    return Geolocation.checkPermissions();
  }
  if (typeof navigator !== "undefined" && "permissions" in navigator) {
    try {
      const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
      return {
        location: status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "prompt",
        coarseLocation: status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "prompt",
      };
    } catch {
      return { location: "prompt", coarseLocation: "prompt" };
    }
  }
  return { location: "prompt", coarseLocation: "prompt" };
}

export async function requestGeolocationPermission(): Promise<PermissionStatus> {
  if (Capacitor.isNativePlatform()) {
    return Geolocation.requestPermissions({ permissions: ["location", "coarseLocation"] });
  }
  return checkGeolocationPermission();
}

export async function getCurrentCoordinates(highAccuracy = true): Promise<PawSpaceCoordinates> {
  if (Capacitor.isNativePlatform()) {
    const position: Position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: highAccuracy,
      timeout: 10000,
      maximumAge: 3000,
    });
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      altitude: position.coords.altitude,
      altitudeAccuracy: position.coords.altitudeAccuracy,
      heading: position.coords.heading,
      speed: position.coords.speed,
      timestamp: position.timestamp,
    };
  }

  // Browser / Web fallback
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw new Error("Geolocation is not supported in this environment");
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          timestamp: pos.timestamp,
        });
      },
      (err) => reject(new Error(err.message || "Failed to get browser location")),
      { enableHighAccuracy: highAccuracy, timeout: 10000, maximumAge: 3000 }
    );
  });
}

export async function watchCoordinates(
  onChange: (coords: PawSpaceCoordinates) => void,
  onError?: (err: Error) => void
): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const id = await Geolocation.watchPosition(
      { enableHighAccuracy: true, timeout: 15000 },
      (position, err) => {
        if (err) {
          onError?.(new Error(err.message));
          return;
        }
        if (position) {
          onChange({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            altitude: position.coords.altitude,
            altitudeAccuracy: position.coords.altitudeAccuracy,
            heading: position.coords.heading,
            speed: position.coords.speed,
            timestamp: position.timestamp,
          });
        }
      }
    );
    return id;
  }

  if (typeof navigator !== "undefined" && navigator.geolocation) {
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        onChange({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          timestamp: pos.timestamp,
        });
      },
      (err) => onError?.(new Error(err.message)),
      { enableHighAccuracy: true }
    );
    return `web-${watchId}`;
  }

  throw new Error("Location watching is unavailable");
}

export async function clearCoordinateWatch(watchId: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Geolocation.clearWatch({ id: watchId });
    return;
  }
  if (watchId.startsWith("web-") && typeof navigator !== "undefined" && navigator.geolocation) {
    navigator.geolocation.clearWatch(Number(watchId.replace("web-", "")));
  }
}
