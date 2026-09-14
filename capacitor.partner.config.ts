import type { CapacitorConfig } from "@capacitor/cli";

const partnerUrl=process.env.PAWSPACE_PARTNER_APP_URL;
if(partnerUrl){const url=new URL(partnerUrl);if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/partner-app")throw new Error("PAWSPACE_PARTNER_APP_URL must be the approved HTTPS /partner-app URL without credentials or query parameters.");}
const config: CapacitorConfig = {
  appId: "com.pawspace.partner",
  appName: "PawSpacePartner",
  webDir: "native/partner-shell",
  server: {
    ...(partnerUrl?{url:partnerUrl}:{}),
    errorPath:"offline.html",
    androidScheme: "https",
    cleartext: false,
  },
  android: {useLegacyBridge:true},
  plugins: {
    CapacitorHttp: {enabled:true},
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    Geolocation: {},
    Camera: {},
  },
};

export default config;
