import type { Metadata } from "next";
import { SITE_URL } from "@/lib/constants";

export const SITE_NAME = "RobinWood ($PLANK)";
export const SITE_TITLE = "RobinWood ($PLANK) — Mint, Trade & Explore";
export const SITE_DESCRIPTION =
  "Mint and collect 1,542 RobinWood NFTs, trade $PLANK, explore rarity, and use Marketplank on Robinhood Chain.";

const SOCIAL_IMAGE = {
  url: "/plank-social.jpg",
  width: 1200,
  height: 630,
  alt: "RobinWood ($PLANK) on plank.love",
} as const;

export const rootMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: "PLANK.LOVE",
  title: {
    default: SITE_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "RobinWood",
    "$PLANK",
    "Robinhood Chain",
    "RobinWood NFT",
    "NFT marketplace",
    "Marketplank",
    "NFT mint",
  ],
  authors: [{ name: "RobinWood", url: SITE_URL }],
  creator: "RobinWood",
  publisher: "RobinWood",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: "/",
    siteName: SITE_NAME,
    locale: "en_US",
    type: "website",
    images: [SOCIAL_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: "@RobinWoodPlank",
    images: [SOCIAL_IMAGE],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  manifest: "/manifest.webmanifest",
  formatDetection: {
    telephone: false,
  },
};

type PageMetadataOptions = {
  title: string;
  description: string;
  path: `/${string}`;
  canonicalPath?: `/${string}`;
  keywords?: string[];
  index?: boolean;
};

export function createPageMetadata({
  title,
  description,
  path,
  canonicalPath = path,
  keywords,
  index = true,
}: PageMetadataOptions): Metadata {
  const socialTitle = `${title} | ${SITE_NAME}`;

  return {
    title,
    description,
    ...(keywords ? { keywords } : {}),
    alternates: {
      canonical: canonicalPath,
    },
    openGraph: {
      title: socialTitle,
      description,
      url: path,
      siteName: SITE_NAME,
      locale: "en_US",
      type: "website",
      images: [SOCIAL_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      site: "@RobinWoodPlank",
      images: [SOCIAL_IMAGE],
    },
    robots: {
      index,
      follow: true,
    },
  };
}
