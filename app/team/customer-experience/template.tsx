import type { ReactNode } from "react";

// Keep this boundary on the server. Live updates belong to the page's data
// loaders; remounting the page would discard the operator's draft and filters.
export default function CustomerExperienceTemplate({ children }: { children: ReactNode }) {
  return children;
}
