"use client";

import { useEffect } from "react";
import RecoveryScreen from "./components/recovery-screen";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Console only: this runs in the browser, so anything richer would ship customer data off-device.
    console.error("PawSpace route error", error.digest ?? "", error.message);
  }, [error]);

  return (
    <RecoveryScreen
      title="Our servers are taking a quick walk. We're on it."
      detail="We couldn't finish loading this screen. Please try again. If you were paying, check your booking before making another payment."
      digest={error.digest}
      onRetry={reset}
    />
  );
}
