import type { ReactNode } from "react";

export default function SittingLayout({ children }: { children: ReactNode }) {
  return <div className="ps-unified-service ps-sitting">{children}</div>;
}
