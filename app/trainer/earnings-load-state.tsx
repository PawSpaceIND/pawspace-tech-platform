import type {ReactNode} from "react";

export default function EarningsLoadState({loading,error,loaded,onRetry,children}:{loading:boolean;error:string;loaded:boolean;onRetry:()=>void;children:ReactNode}) {
  if (loading) return <section role="status"><h2>Loading Training earnings…</h2></section>;
  if (error || !loaded) return <section role="alert"><h2>Training earnings are unavailable</h2><p>{error || "The earnings ledger has not loaded. Please retry."}</p><button onClick={onRetry}>Retry earnings</button></section>;
  return <>{children}</>;
}
