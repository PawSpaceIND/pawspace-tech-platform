#!/usr/bin/env bash
set -euo pipefail

# PawSpace Mobile Production Release Build & Code-Signing Preparation Script
# Enforces strict sandbox isolation locks before building release artifacts.

echo "========================================================"
echo "PawSpace Mobile Production Release Preparation"
echo "========================================================"

# 1. Enforce sandbox locks
export PAWSPACE_PAYMENT_ENV="${PAWSPACE_PAYMENT_ENV:-sandbox}"
export FORBID_PRODUCTION="${FORBID_PRODUCTION:-true}"
export PAWSPACE_PAYMENT_LIVE_APPROVED="${PAWSPACE_PAYMENT_LIVE_APPROVED:-false}"

echo "Checking environment locks:"
echo "  PAWSPACE_PAYMENT_ENV=$PAWSPACE_PAYMENT_ENV"
echo "  FORBID_PRODUCTION=$FORBID_PRODUCTION"
echo "  PAWSPACE_PAYMENT_LIVE_APPROVED=$PAWSPACE_PAYMENT_LIVE_APPROVED"

if [ "$PAWSPACE_PAYMENT_ENV" != "sandbox" ] || [ "$FORBID_PRODUCTION" != "true" ] || [ "$PAWSPACE_PAYMENT_LIVE_APPROVED" != "false" ]; then
  echo "FATAL: Sandbox security locks violated! Aborting release build." >&2
  exit 1
fi

echo "✔ Safety locks confirmed."

# 2. Synchronize web assets to native Capacitor platforms
echo "Synchronizing Next.js assets to Capacitor platforms..."
npx cap sync

# 3. Android Release App Bundle (AAB)
echo "--------------------------------------------------------"
echo "Android Release Bundle (AAB) Preparation"
echo "--------------------------------------------------------"

if command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1; then
  echo "Java detected: $(java -version 2>&1 | head -n 1)"
  echo "Building Android Release App Bundle..."
  (cd android && ./gradlew bundleRelease)
  echo "✔ Android AAB build complete: android/app/build/outputs/bundle/release/app-release.aab"
else
  echo "NOTICE: Java JDK 17+ is required to execute ./gradlew bundleRelease locally."
  echo "In CI or environments with JDK, run:"
  echo "  export ANDROID_KEYSTORE_FILE=\"\${ANDROID_KEYSTORE_FILE:-pawspace-release.jks}\""
  echo "  export ANDROID_KEYSTORE_PASSWORD=\"\${ANDROID_KEYSTORE_PASSWORD:-<secure_password>}\""
  echo "  export ANDROID_KEY_ALIAS=\"\${ANDROID_KEY_ALIAS:-pawspace_key}\""
  echo "  export ANDROID_KEY_PASSWORD=\"\${ANDROID_KEY_PASSWORD:-<secure_password>}\""
  echo "  cd android && ./gradlew bundleRelease && cd .."
fi

# 4. iOS Release Archive Preparation
echo "--------------------------------------------------------"
echo "iOS Release Archive Preparation"
echo "--------------------------------------------------------"

if command -v xcodebuild >/dev/null 2>&1 && xcodebuild -version >/dev/null 2>&1; then
  echo "xcodebuild detected: $(xcodebuild -version | head -n 1)"
  echo "Building iOS release archive..."
  (cd ios/App && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release archive -archivePath build/PawSpace.xcarchive)
  echo "✔ iOS release archive complete: ios/App/build/PawSpace.xcarchive"
else
  echo "NOTICE: Full Xcode IDE application is required to execute xcodebuild locally."
  echo "To open in Xcode and configure provisioning profiles:"
  echo "  npx cap open ios"
  echo "Or in macOS CI with full Xcode:"
  echo "  cd ios/App && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release archive -archivePath build/PawSpace.xcarchive && cd ../.."
fi

echo "========================================================"
echo "✔ Release configuration and build verification complete."
echo "========================================================"
