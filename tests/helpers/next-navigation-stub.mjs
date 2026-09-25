export function usePathname() {
  return globalThis.__PAWSPACE_TEST_PATHNAME__ || "/team";
}

export function useSearchParams() {
  const value = globalThis.__PAWSPACE_TEST_SEARCH_PARAMS__;
  if (value instanceof URLSearchParams) return value;
  if (typeof value === "string") return new URLSearchParams(value);
  return new URLSearchParams();
}

export function redirect(location) {
  const error = new Error(`NEXT_REDIRECT:${location}`);
  error.digest = `NEXT_REDIRECT;replace;${location};307;`;
  throw error;
}
