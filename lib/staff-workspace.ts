// Navigation only; destination APIs continue to enforce their own permissions.
export function staffWorkspace(role: unknown): string {
  return role === "service_provider" ? "/me" : "/team";
}
