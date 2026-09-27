/** The services Finance reconciles from /team/finance, with the workspace that acts on one booking of each. Client-safe. */
export const FINANCE_SERVICES=[
  {code:"boarding",label:"Boarding",workspace:"/team/finance/boarding"},
  {code:"pet_sitting",label:"Pet Sitting",workspace:"/team/finance/sitting"},
  {code:"pet_taxi",label:"Pet Taxi",workspace:"/team/finance/taxi"},
  {code:"grooming",label:"Grooming",workspace:null},
  {code:"dog_training",label:"Training",workspace:"/team/finance/training"},
] as const;
export type FinanceServiceCode=typeof FINANCE_SERVICES[number]["code"];
const SERVICE_CODES:readonly string[]=FINANCE_SERVICES.map(service=>service.code);
export function financeServiceCode(value:unknown):FinanceServiceCode|null{const code=String(value??"").trim();return SERVICE_CODES.includes(code)?code as FinanceServiceCode:null;}
export function financeServiceLabel(code:unknown){return FINANCE_SERVICES.find(service=>service.code===code)?.label??String(code??"").replaceAll("_"," ");}
