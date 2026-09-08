import type { ReactNode } from "react";

// Live invalidation belongs to the page's data loaders. Remounting this subtree erases CX drafts.
export default function CustomerExperienceLiveTemplate({ children }: { children: ReactNode }) {
  return children;
}
