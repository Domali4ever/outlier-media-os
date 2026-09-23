import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@modelcontextprotocol/sdk"],
  poweredByHeader: false,
  typedRoutes: false,
};

export default nextConfig;
