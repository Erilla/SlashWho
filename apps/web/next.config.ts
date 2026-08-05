import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: [
    "@slashwho/application",
    "@slashwho/contracts",
    "@slashwho/database",
    "@slashwho/domain"
  ]
};

export default nextConfig;
