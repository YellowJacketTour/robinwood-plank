import type { Metadata, Viewport } from "next";
import { Uncial_Antiqua, Nunito_Sans } from "next/font/google";
import "./globals.css";
import { SITE_URL } from "@/lib/constants";
import PlankBackground from "@/components/PlankBackground";

const stencil = Uncial_Antiqua({
  variable: "--font-stencil",
  subsets: ["latin"],
  weight: "400",
});

const body = Nunito_Sans({
  variable: "--font-body",
  subsets: ["latin"],
});

const title = "RobinWood ($PLANK) — Robinhood Chain NFT Mint & Meme Coin";
const description =
  "The Robinhood Chain is officially live. RobinWood is a woodsy meme-native NFT collection built to bootstrap and support $PLANK from day one. Plank is Plank.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description,
  keywords: ["RobinWood", "PLANK", "Robinhood Chain", "meme coin", "NFT mint", "crypto"],
  openGraph: {
    title,
    description,
    url: SITE_URL,
    siteName: "RobinWood ($PLANK)",
    type: "website",
    images: [
      {
        url: "/images/plank-check-signed.jpg",
        width: 1280,
        height: 719,
        alt: "RobinWood Plank check",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/images/plank-check-signed.jpg"],
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  themeColor: "#14100b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${stencil.variable} ${body.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <PlankBackground />
        {children}
      </body>
    </html>
  );
}
