import type { ReactNode } from "react";

export default function BoardingLayout({ children }: { children: ReactNode }) {
  return <div className="ps-unified-service ps-boarding">{children}</div>;
}
