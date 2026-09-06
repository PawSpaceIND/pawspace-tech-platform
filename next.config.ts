import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Cloudflare/vinext release-preview Worker serves static public assets directly.
  // Routing Next Image requests through /_vinext/image produced broken images in the
  // exact-SHA UI closure preview even though the source files exist in public/assets.
  // Keep image delivery deterministic across preview and production Workers by using
  // the original static asset URLs instead of a runtime image optimizer endpoint.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
