import type { ReactNode } from "react";

export default function TaxiLayout({ children }: { children: ReactNode }) {
  return <div className="ps-unified-service ps-taxi">{children}</div>;
}
