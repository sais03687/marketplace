import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@marketplace/db", "@marketplace/agent-package-schema"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "img.clerk.com" },
      { protocol: "https", hostname: "*.r2.cloudflarestorage.com" },
    ],
  },
};

export default nextConfig;
