import { NativeMarket } from "@capacitor-community/native-market";
import { Capacitor } from "@capacitor/core";

export async function openStoreDetails(appId?: string): Promise<void> {
  const targetId = appId || (Capacitor.getPlatform() === "ios" ? "com.pawspace.customer" : "com.pawspace.customer");
  if (Capacitor.isNativePlatform()) {
    await NativeMarket.openStoreListing({ appId: targetId });
    return;
  }
  if (typeof window !== "undefined") {
    window.open(`https://play.google.com/store/apps/details?id=${encodeURIComponent(targetId)}`, "_blank");
  }
}

export async function promptStoreReview(appId?: string): Promise<void> {
  const targetId = appId || "com.pawspace.customer";
  if (Capacitor.isNativePlatform()) {
    await NativeMarket.openDevPage({ devId: targetId });
    return;
  }
  await openStoreDetails(targetId);
}
