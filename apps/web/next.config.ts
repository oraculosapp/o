import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // El engine y demás paquetes internos se distribuyen como TS puro:
  // Next los transpila en vez de consumir un build propio.
  transpilePackages: ["@phygitalia/engine", "@phygitalia/ui", "@phygitalia/content"],
};

export default nextConfig;
