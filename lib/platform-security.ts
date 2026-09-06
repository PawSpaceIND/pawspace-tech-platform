export const permissionCatalog = [
  "dashboard.view", "customers.view", "customers.view_full_phone", "customers.export",
  "customers.manage", "bookings.view", "bookings.manage", "grooming.manage", "providers.manage",
  "scheduling.view", "scheduling.book", "scheduling.manage", "pricing.view", "pricing.manage",
  "marketing.view", "marketing.manage", "finance.view", "finance.manage",
  "people.view", "people.manage", "attendance.view", "attendance.manage", "leave.view", "leave.manage",
  "compensation.view", "compensation.manage", "payroll.view", "payroll.manage", "payroll.approve",
  "incentives.view", "incentives.manage", "performance.view", "performance.manage",
  "self_service.view",
  "launch.view", "launch.manage",
  "communications.call", "communications.message", "communications.manage", "payments.view", "payments.manage",
  "reports.view", "data.import", "data.delete", "users.manage", "roles.manage",
  "settings.manage", "audit.view",
] as const;

export type Permission = (typeof permissionCatalog)[number];

export const defaultRoles = [
  { code:"founder", name:"Founder", description:"Permanent owner-level identity with complete oversight and protected founder controls.", permissions:["*"] },
  { code:"superuser", name:"Superuser", description:"Runs the full platform; cannot remove or downgrade the founder.", permissions:["*"] },
  { code:"admin", name:"Admin", description:"Manages operations, customers, providers and service settings.", permissions:["dashboard.view","customers.view","customers.view_full_phone","customers.manage","bookings.view","bookings.manage","grooming.manage","providers.manage","scheduling.view","scheduling.book","scheduling.manage","pricing.view","pricing.manage","marketing.view","marketing.manage","finance.view","people.view","people.manage","attendance.view","attendance.manage","leave.view","leave.manage","payroll.view","performance.view","performance.manage","launch.view","launch.manage","communications.call","communications.message","communications.manage","payments.view","reports.view","data.import","users.manage","audit.view","self_service.view"] },
  { code:"manager", name:"Manager", description:"Runs a team or city with customer and booking controls.", permissions:["dashboard.view","customers.view","customers.manage","bookings.view","bookings.manage","grooming.manage","providers.manage","scheduling.view","scheduling.book","scheduling.manage","pricing.view","marketing.view","people.view","attendance.view","attendance.manage","leave.view","leave.manage","performance.view","launch.view","launch.manage","communications.call","communications.message","communications.manage","reports.view","self_service.view"] },
  { code:"associate", name:"Associate", description:"Handles assigned customers and bookings with masked contact data plus own employee self-service when linked to an employee record.", permissions:["dashboard.view","customers.view","bookings.view","scheduling.book","pricing.view","communications.call","communications.message","communications.manage","attendance.view","leave.view","performance.view","self_service.view"] },
  { code:"customer", name:"Customer", description:"Self-service customer identity limited to pricing and creating/changing its own bookings through ownership checks.", permissions:["pricing.view","scheduling.book"] },
  { code:"service_provider", name:"Service provider", description:"Sees assigned jobs only; calls and messages without seeing the customer number, plus own earnings/rank self-service when linked to an employee record.", permissions:["bookings.view","scheduling.view","communications.call","communications.message","self_service.view"] },
  { code:"finance", name:"Finance", description:"Payment, refund, invoice, payroll and reconciliation access without customer contact exposure.", permissions:["dashboard.view","payments.view","payments.manage","finance.view","finance.manage","compensation.view","payroll.view","payroll.manage","reports.view","audit.view"] },
  { code:"auditor", name:"Auditor", description:"Read-only compliance and audit access with masked personal data.", permissions:["dashboard.view","reports.view","people.view","attendance.view","leave.view","payroll.view","incentives.view","performance.view","audit.view"] },
] as const;

export function parsePermissions(value:unknown):string[]{
  if(Array.isArray(value)) return value.filter((item):item is string=>typeof item==="string");
  if(typeof value!=="string") return [];
  try{return parsePermissions(JSON.parse(value));}catch{return [];}
}

/**
 * A role that carries the wildcard holds every permission there is, present and future.
 *
 * Both `founder` and `superuser` are defined as ["*"], and the governance route guarded only the
 * literal string "founder" — so an actor with users.manage could assign `superuser` and obtain the
 * same total authority the founder guard existed to prevent. Deriving the protected set from the
 * PERMISSIONS rather than from a list of names means a tenth role defined as ["*"] tomorrow is
 * protected the moment it is defined, instead of reopening the hole until someone remembers to add it
 * to a hardcoded list.
 */
export function isFullAccessRole(permissions:unknown){return parsePermissions(permissions).includes("*");}

/** Role codes that may never be assigned through ordinary user management, derived not enumerated. */
export function fullAccessRoleCodes(roles:Array<{code:string;permissions?:unknown;permissions_json?:unknown}>){
 return roles.filter(role=>isFullAccessRole(role.permissions??role.permissions_json)).map(role=>role.code);
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
