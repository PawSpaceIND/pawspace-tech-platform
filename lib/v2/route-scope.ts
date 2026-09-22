export function isV2CustomerPath(pathname: string): boolean {
  return pathname === "/v2" || pathname.startsWith("/v2/");
}

const CUSTOMER_ROOTS = ["/grooming", "/boarding", "/training", "/sitting", "/walking", "/food", "/relocation", "/taxi"] as const;

export function customerScopedHref(pathname: string, legacyHref: string): string {
  if (!isV2CustomerPath(pathname)) return legacyHref;
  if (legacyHref === "/") return "/v2";
  if (legacyHref === "/mobile-app") return "/v2/account";
  if (legacyHref.startsWith("/v2/")) return legacyHref;
  if (CUSTOMER_ROOTS.some(root => legacyHref === root || legacyHref.startsWith(root + "/") || legacyHref.startsWith(root + "?"))) {
    return "/v2" + legacyHref;
  }
  return legacyHref;
}
