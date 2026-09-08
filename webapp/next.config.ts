import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  assetPrefix: process.env.NEXT_PUBLIC_EMBEDDED_BUILD === "true" ? "." : undefined,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
