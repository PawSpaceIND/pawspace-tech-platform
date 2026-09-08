import type { ReactNode } from "react";

export default function CustomerExperienceLiveTemplate({children}:{children:ReactNode}){
 // The inbox page refreshes data without remounting. A keyed stream wrapper
 // discarded unsent drafts and selection on every event or fallback interval.
 return <>{children}</>;
}
