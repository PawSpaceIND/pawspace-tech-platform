import type { CapacitorConfig } from "@capacitor/cli";
import customerConfig from "./capacitor.customer.config";
import partnerConfig from "./capacitor.partner.config";

const target = (process.env.CAPACITOR_TARGET || process.env.APP_TARGET || "customer").toLowerCase();
const config: CapacitorConfig = target === "partner" ? partnerConfig : customerConfig;

export default config;
