export const permissionCatalog = [
  "dashboard.view", "customers.view", "customers.view_full_phone", "customers.export",
  "customers.manage", "bookings.view", "bookings.manage", "grooming.manage", "providers.manage",
  "scheduling.view", "scheduling.book", "scheduling.manage", "pricing.view", "pricing.manage",
  "marketing.view", "marketing.manage", "finance.view", "finance.manage",
  "launch.view", "launch.manage",
  "communications.call", "communications.message", "payments.view", "payments.manage",
  "reports.view", "data.import", "data.delete", "users.manage", "roles.manage",
  "settings.manage", "audit.view",
] as const;

export type Permission = (typeof permissionCatalog)[number];

export const defaultRoles = [
  { code:"founder", name:"Founder", description:"Permanent owner-level identity with complete oversight and protected founder controls.", permissions:["*"] },
  { code:"superuser", name:"Superuser", description:"Runs the full platform; cannot remove or downgrade the founder.", permissions:["*"] },
  { code:"admin", name:"Admin", description:"Manages operations, customers, providers and service settings.", permissions:["dashboard.view","customers.view","customers.view_full_phone","customers.manage","bookings.view","bookings.manage","grooming.manage","providers.manage","scheduling.view","scheduling.book","scheduling.manage","pricing.view","pricing.manage","marketing.view","marketing.manage","finance.view","launch.view","launch.manage","communications.call","communications.message","payments.view","reports.view","data.import","users.manage","audit.view"] },
  { code:"manager", name:"Manager", description:"Runs a team or city with customer and booking controls.", permissions:["dashboard.view","customers.view","customers.manage","bookings.view","bookings.manage","grooming.manage","providers.manage","scheduling.view","scheduling.book","scheduling.manage","pricing.view","marketing.view","launch.view","launch.manage","communications.call","communications.message","reports.view"] },
  { code:"associate", name:"Associate", description:"Handles assigned customers and bookings with masked contact data.", permissions:["dashboard.view","customers.view","bookings.view","scheduling.book","pricing.view","communications.call","communications.message"] },
  { code:"service_provider", name:"Service provider", description:"Sees assigned jobs only; calls and messages without seeing the customer number.", permissions:["bookings.view","scheduling.view","communications.call","communications.message"] },
  { code:"finance", name:"Finance", description:"Payment, refund, invoice and reconciliation access without customer contact exposure.", permissions:["dashboard.view","payments.view","payments.manage","finance.view","finance.manage","reports.view","audit.view"] },
  { code:"auditor", name:"Auditor", description:"Read-only compliance and audit access with masked personal data.", permissions:["dashboard.view","reports.view","audit.view"] },
] as const;

export function parsePermissions(value:unknown):string[]{
  if(Array.isArray(value)) return value.filter((item):item is string=>typeof item==="string");
  if(typeof value!=="string") return [];
  try{return parsePermissions(JSON.parse(value));}catch{return [];}
}

export function hasPermission(rolePermissions:string[], permission:Permission){
  return rolePermissions.includes("*") || rolePermissions.includes(permission);
}

export function maskPhone(value:string|null|undefined){
  if(!value)return "Not available";
  const digits=value.replace(/\D/g,"");
  if(digits.length<4)return "••••";
  return `+91 ••••••${digits.slice(-4)}`;
}

export function maskName(value:string){
  const parts=value.trim().split(/\s+/).filter(Boolean);
  if(!parts.length)return "Customer";
  return parts.map((part,index)=>index===0?`${part[0]}${"•".repeat(Math.max(2,Math.min(part.length-1,5)))}`:`${part[0]}•`).join(" ");
}
