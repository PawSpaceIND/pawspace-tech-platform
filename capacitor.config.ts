import type { CapacitorConfig } from "@capacitor/cli";
import customerConfig from "./capacitor.customer.config";
import partnerConfig from "./capacitor.partner.config";

const target = (process.env.CAPACITOR_TARGET || process.env.APP_TARGET || "customer").toLowerCase();
if (target !== "customer" && target !== "partner") {
  throw new Error("CAPACITOR_TARGET must be customer or partner");
}
const config: CapacitorConfig = target === "partner" ? partnerConfig : customerConfig;

export default config;
