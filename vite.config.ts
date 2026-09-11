import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  vars: {
    NODE_ENV: process.env.NODE_ENV || "",
    FORBID_PRODUCTION: process.env.FORBID_PRODUCTION || "",
    PAWSPACE_DEPLOYMENT_ENV: process.env.PAWSPACE_DEPLOYMENT_ENV || "",
    PAWSPACE_LOCAL_PREVIEW: process.env.PAWSPACE_LOCAL_PREVIEW || "on",
    PAWSPACE_SCHEDULING_ENV: process.env.PAWSPACE_SCHEDULING_ENV || "uat",
    PAWSPACE_MEDIA_ENV: process.env.PAWSPACE_MEDIA_ENV || "uat",
    PAWSPACE_PAYMENT_ENV: "sandbox",
    PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
    PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: process.env.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE === "on" ? "on" : "off",
    PAWSPACE_UAT_LOGIN: process.env.PAWSPACE_UAT_LOGIN || "off",
    PAWSPACE_UAT_ACCESS_CODE: process.env.PAWSPACE_UAT_ACCESS_CODE || "",
    PAWSPACE_UAT_SIGNING_KEY: process.env.PAWSPACE_UAT_SIGNING_KEY || "",
    PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: process.env.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT || "",
    PAWSPACE_IDENTITY_ENV: process.env.PAWSPACE_IDENTITY_ENV || "sandbox",
    PAWSPACE_WORKSPACE_IDENTITY_TRUST: process.env.PAWSPACE_WORKSPACE_IDENTITY_TRUST || "",
    PAWSPACE_MAPS_ENV: process.env.PAWSPACE_MAPS_ENV || "sandbox",
    PAWSPACE_UAT_SERVICE_CLOCK: process.env.PAWSPACE_UAT_SERVICE_CLOCK || "off",
    PAWSPACE_UAT_EXECUTION_NOW_MS: process.env.PAWSPACE_UAT_EXECUTION_NOW_MS || "",
  },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      watch: {
        // D1/Miniflare writes can emit events for both the directory node and
        // descendants. Ignore both so sandbox OTP writes cannot remount the UI.
        ignored: ["**/.wrangler", "**/.wrangler/**"],
        ...(isCodexSeatbeltSandbox
          ? { useFsEvents: false, usePolling: true }
          : {}),
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});