import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.pawspace.customer",
  appName: "PawSpaceCustomer",
  webDir: ".next",
  server: {
    androidScheme: "https",
    cleartext: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    Geolocation: {},
    Camera: {},
  },
};

export default config;
