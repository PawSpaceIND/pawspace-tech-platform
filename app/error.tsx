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
      title="This page didn't load"
      detail="Something went wrong while preparing this screen. Trying again usually works — the rest of PawSpace is unaffected."
      digest={error.digest}
      onRetry={reset}
    />
  );
}
