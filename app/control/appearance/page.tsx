"use client";
import AppearancePlatformPanel from "../appearance-platform-panel";

export default function ControlAppearancePage() {
  return <main>
    <h1>Platform appearance</h1>
    <AppearancePlatformPanel notify={(message) => window.alert(message)} />
  </main>;
}
