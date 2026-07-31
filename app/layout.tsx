import type { Metadata, Viewport } from "next";
import { Uncial_Antiqua, Nunito_Sans } from "next/font/google";
import "./globals.css";
import PlankBackground from "@/components/PlankBackground";
import WoodAmpProvider from "@/components/woodamp/WoodAmpProvider";
import WoodAmpWindow from "@/components/woodamp/WoodAmpWindow";
import HoloField from "@/lib/holo";
import SplashIntro from "@/components/SplashIntro";
import SiteBanner from "@/components/SiteBanner";
import ArtServiceWorker from "@/components/ArtServiceWorker";
import { rootMetadata } from "@/lib/seo";
import { WalletProvider } from "@/lib/wallet-context";

const stencil = Uncial_Antiqua({
  variable: "--font-stencil",
  subsets: ["latin"],
  weight: "400",
});

const body = Nunito_Sans({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = rootMetadata;

export const viewport: Viewport = {
  themeColor: "#14100b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // Help wallet in-app browsers lay out full-width without odd letterboxing
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${stencil.variable} ${body.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <WalletProvider>
          {/* WoodAmp owns the site's single audio element; it lives here in
              the root layout so playback survives client-side navigation
              (route links in Nav use <Link> for exactly this reason). */}
          <WoodAmpProvider>
            <SplashIntro />
            <ArtServiceWorker />
            <PlankBackground />
            <HoloField />
            {/* Admin-managed announcement — renders nothing unless enabled */}
            <SiteBanner />
            {children}
            <WoodAmpWindow />
          </WoodAmpProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
