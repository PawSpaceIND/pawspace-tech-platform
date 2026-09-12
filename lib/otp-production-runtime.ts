import{productionSmsReadiness}from"./production-sms-provider";
export function productionOtpEnabled(runtime:Record<string,unknown>={}){return productionSmsReadiness(runtime).ready;}
