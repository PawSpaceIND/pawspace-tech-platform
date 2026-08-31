import type { ReactNode } from "react";

export default function WalkingLayout({ children }: { children: ReactNode }) {
  return <div className="ps-unified-service ps-walking">{children}</div>;
}
