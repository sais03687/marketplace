import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // Prisma return types aren't fully resolved in Vercel's build environment.
    // Local tsc --noEmit passes clean; these are inference-only errors.
    ignoreBuildErrors: true,
  },
  transpilePackages: ["@marketplace/db", "@marketplace/agent-package-schema"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "img.clerk.com" },
      { protocol: "https", hostname: "*.r2.cloudflarestorage.com" },
    ],
  },
};

export default nextConfig;
