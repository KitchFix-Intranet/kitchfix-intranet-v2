import type { NextConfig } from "next";

const config: NextConfig = {
  // Serverless certificate rendering - keep pdf-lib and its lazy font
  // / image deps as externals so Vercel's function tracer requires them
  // from node_modules at runtime instead of bundling. Without this, the
  // /api/academy/certificate/[attestationId] handler 503s in production
  // on a pre-handler init failure (not catchable from inside the
  // handler). Next 16 stable top-level key - do NOT use the retired
  // experimental.serverComponentsExternalPackages.
  serverExternalPackages: ["pdf-lib"],
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default config;
