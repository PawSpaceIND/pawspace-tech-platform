import React from "react";

function hrefValue(href) {
  if (typeof href === "string") return href;
  if (!href || typeof href !== "object") return "";
  const pathname = href.pathname ?? "";
  const query = href.query && typeof href.query === "object"
    ? new URLSearchParams(Object.entries(href.query).map(([key, value]) => [key, String(value)])).toString()
    : "";
  return query ? `${pathname}?${query}` : pathname;
}

export default function TestNextLink({ children, href, replace: _replace, scroll: _scroll, prefetch: _prefetch, shallow: _shallow, locale: _locale, onNavigate: _onNavigate, ...rest }) {
  return React.createElement("a", { ...rest, href: hrefValue(href) }, children);
}

export function useLinkStatus() {
  return { pending: false };
}
