/**
 * PawSpace Mobile Native Bridge & Capabilities Suite
 */
import { Capacitor } from "@capacitor/core";

export * from "./geolocation";
export * from "./push-notifications";
export * from "./camera";
export * from "./native-market";
export * from "./razorpay";

export const PawSpaceDevice = {
  isNative(): boolean {
    return Capacitor.isNativePlatform();
  },
  getPlatform(): "ios" | "android" | "web" {
    return Capacitor.getPlatform() as "ios" | "android" | "web";
  },
};
