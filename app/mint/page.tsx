import type { Metadata } from "next";
import Home from "../page";

const shareImage =
  "https://plank.love/images/plank-check-signed.jpg?v=20260723";

export const metadata: Metadata = {
  title: "PLANK.LOVE — RobinWood Mint",
  description: "Join the RobinWood allowlist and mint on Robinhood Chain.",
  alternates: {
    canonical: "https://plank.love/mint",
  },
  openGraph: {
    title: "PLANK.LOVE — RobinWood Mint",
    description: "Join the RobinWood allowlist and mint on Robinhood Chain.",
    url: "https://plank.love/mint",
    siteName: "PLANK.LOVE",
    type: "website",
    images: [
      {
        url: shareImage,
        width: 1280,
        height: 719,
        alt: "PLANK.LOVE signed check",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "PLANK.LOVE — RobinWood Mint",
    description: "Join the RobinWood allowlist and mint on Robinhood Chain.",
    images: [shareImage],
  },
};

export default Home;
