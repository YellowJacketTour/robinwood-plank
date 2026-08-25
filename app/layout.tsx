import type { Metadata, Viewport } from "next";
import { Uncial_Antiqua, Nunito_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import PlankBackground from "@/components/PlankBackground";
import WoodAmpProvider from "@/components/woodamp/WoodAmpProvider";
import WoodAmpWindow from "@/components/woodamp/WoodAmpWindow";
import HoloField from "@/lib/holo";
import SplashIntro from "@/components/SplashIntro";
import SiteBanner from "@/components/SiteBanner";
import MigrateBanner from "@/components/MigrateBanner";
import ArtServiceWorker from "@/components/ArtServiceWorker";
import VersionUpdatePrompt from "@/components/VersionUpdatePrompt";
import { rootMetadata } from "@/lib/seo";
import { WalletProvider } from "@/lib/wallet-context";
import { ACCENT_BOOTSTRAP_SCRIPT } from "@/lib/theme-accent";
import DiscoFluidBackdrop from "@/components/DiscoFluidBackdrop";

const stencil = Uncial_Antiqua({
  variable: "--font-stencil",
  subsets: ["latin"],
  weight: "400",
});

const body = Nunito_Sans({
  variable: "--font-body",
  subsets: ["latin"],
});

/**
 * Trading-surface data typeface (design-direction preview, 2026-08-19 --
 * see docs the artifact this branch implements). Real trader terminals
 * (Axiom, Photon, Blur, Tensor -- verified live via research, not
 * assumed) universally set price/volume/percentage data in a monospace
 * face: tabular-nums alone keeps digit WIDTHS aligned in a proportional
 * font, but only a true monospace keeps every GLYPH (currency symbols,
 * arrows, the decimal point itself) on a fixed grid, which is what makes
 * a scanning trader's eye track a column instead of re-parsing each row.
 * Scoped narrowly: this is a THIRD variable alongside the existing
 * --font-stencil (headings) and --font-body (prose/UI) -- it never
 * replaces either, and nothing outside explicitly-opted-in trading-data
 * cells should reference --font-data at all.
 */
const dataFont = JetBrains_Mono({
  variable: "--font-data",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
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
    <html
      lang="en"
      className={`${stencil.variable} ${body.variable} ${dataFont.variable} h-full antialiased`}
      // The accent-theme bootstrap script below intentionally sets a
      // `style` attribute on this element before hydration (same pattern
      // every dark-mode bootstrap script uses) -- React correctly notices
      // the SSR HTML had no such attribute and would otherwise warn "won't
      // be patched up" on every load. suppressHydrationWarning here is the
      // standard, narrow fix for exactly this one intentionally-divergent
      // attribute; it does not silence any other hydration mismatch.
      suppressHydrationWarning
    >
      <head>
        {/* Applies any saved accent theme (ThemeAccentPicker) before first
            paint -- same reasoning as any dark-mode bootstrap script, just
            for the site's one custom accent hue instead of a light/dark
            class. Without this, a returning visitor with a saved non-gold
            theme would see a flash of default gold on every load. */}
        <script dangerouslySetInnerHTML={{ __html: ACCENT_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <WalletProvider>
          {/* WoodAmp owns the site's single audio element; it lives here in
              the root layout so playback survives client-side navigation
              (route links in Nav use <Link> for exactly this reason). */}
          <WoodAmpProvider>
            <DiscoFluidBackdrop />
            <SplashIntro />
            <ArtServiceWorker />
            {/* Tells a stale tab a new build shipped. DEPLOYMENT_VERSION is
                the release SHA in production and unset locally, so this is
                inert in dev rather than prompting against a fixed marker. */}
            <VersionUpdatePrompt currentBuild={process.env.DEPLOYMENT_VERSION?.trim() || null} />
            <PlankBackground />
            <HoloField />
            {/* Admin-managed announcement — renders nothing unless enabled */}
            <SiteBanner />
            {/* Wallet-detected vault-migration reminder — renders nothing unless
                a connected wallet holds legacy value and isn't on /migrate */}
            <MigrateBanner />
            {children}
            <WoodAmpWindow />
          </WoodAmpProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
