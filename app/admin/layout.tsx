import type { ReactNode } from "react";

/** Presentation is supplied by each existing Admin page, including error states. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
