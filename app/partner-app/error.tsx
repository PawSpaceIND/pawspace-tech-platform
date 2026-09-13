"use client";

import { useEffect } from "react";
import RecoveryScreen from "../components/recovery-screen";

export default function PartnerAppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("PawSpace partner app error", error.digest ?? "", error.message);
  }, [error]);

  return (
    <RecoveryScreen
      title="This partner screen didn't load"
      detail="The job list is safe. Try again, or go back to the partner home."
      digest={error.digest}
      onRetry={reset}
      homeHref="/partner-app"
    />
  );
}
