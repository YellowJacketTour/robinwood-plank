import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/opengraph-image", destination: "/plank-social.jpg" },
      { source: "/opengraph-image.png", destination: "/plank-social.jpg" },
    ];
  },
  async headers() {
    return [
      {
        source: "/plank-social.jpg",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
