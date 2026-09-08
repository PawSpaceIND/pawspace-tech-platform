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
      detail="Something took an unexpected pause while preparing this screen. Your bookings, pets, and payments are safe — trying again usually works."
      digest={error.digest}
      onRetry={reset}
    />
  );
}
