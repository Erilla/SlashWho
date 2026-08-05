import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@slashwho/application",
    "@slashwho/contracts",
    "@slashwho/database",
    "@slashwho/domain"
  ]
};

export default nextConfig;
