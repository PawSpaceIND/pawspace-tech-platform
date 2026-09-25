import type { ReactNode } from "react";

/** Each child now owns its scoped StaffModule; no legacy global colour override. */
export default function CrmLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
