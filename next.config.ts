import type { NextConfig } from "next";

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  api: {
    bodyParser: {
      sizeLimit: "50mb",
    },
  },
} satisfies NextConfig;

export default nextConfig;
