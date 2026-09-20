import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: { authInterrupts: true },
  transpilePackages: [
    "@slashwho/application",
    "@slashwho/contracts",
    "@slashwho/database",
    "@slashwho/domain"
  ]
};

export default nextConfig;
