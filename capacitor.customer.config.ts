import type { CapacitorConfig } from "@capacitor/cli";

const customerUrl = process.env.PAWSPACE_CUSTOMER_APP_URL;
if (customerUrl) {
  const url = new URL(customerUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mobile-app") throw new Error("PAWSPACE_CUSTOMER_APP_URL must be an HTTPS /mobile-app URL without credentials or query parameters.");
}
const config: CapacitorConfig = {
  appId: "com.pawspace.customer",
  appName: "PawSpaceCustomer",
  webDir: "native/customer-shell",
  server: {
    ...(customerUrl ? { url: customerUrl } : {}),
    errorPath: "offline.html",
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
