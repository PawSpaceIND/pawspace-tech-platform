"use client";

import { useEffect } from "react";
import RecoveryScreen from "../components/recovery-screen";

/**
 * The customer app is the surface a UAT tester spends most of their session in, and the one where a
 * white page ends the round. It gets its own boundary so a failure in one flow (grooming, stay, taxi)
 * does not take down the shell, and so "back to the app" is one tap rather than a re-navigation.
 */
export default function MobileAppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("PawSpace customer app error", error.digest ?? "", error.message);
  }, [error]);

  return (
    <RecoveryScreen
      title="Our servers are taking a quick walk. We're on it."
      detail="Something took an unexpected pause in the customer app. Your bookings, pets, and payments are safe — trying again usually gets everything right back on track."
      digest={error.digest}
      onRetry={reset}
      homeHref="/mobile-app"
    />
  );
}
