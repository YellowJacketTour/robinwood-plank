import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import NativeBitcoinListingsPanel from "@/components/market/NativeBitcoinListingsPanel";
import ComingSoonGate from "@/components/market/ComingSoonGate";
import { MARKET_ENABLED } from "@/lib/constants";
import { getContent } from "@/lib/content-store";
import type { FlagsDoc } from "@/lib/content-docs";
import { createPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

/**
 * Standalone route for the native Bitcoin Ordinals listing engine's first
 * UI (NativeBitcoinListingsPanel) -- separate from /market/multichain's
 * existing collection/chain-browsing surface on purpose. That view is a
 * large, already-proven EVM/Solana/Bitcoin-discovery experience; bolting
 * an early, testnet4-only Bitcoin listing panel into it risks destabilizing
 * something that already works. This route can be linked from there (or
 * folded in) once the panel has real mainnet usage behind it -- same
 * "new route, never modify the existing audited one" discipline this
 * session has held throughout.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = createPageMetadata({
  title: "Native Bitcoin Listings — Marketplank",
  description: "List and buy Bitcoin Ordinals directly with Marketplank's own PSBT engine — no third-party order book, testnet4.",
  path: "/market/bitcoin-listings",
  keywords: ["Marketplank", "Bitcoin Ordinals", "PSBT", "native listing"],
});

export default async function NativeBitcoinListingsPage() {
  const flags = (await getContent("flags").catch(() => null)) as FlagsDoc | null;
  const marketEnabled = flags && flags.marketEnabled !== null ? flags.marketEnabled : MARKET_ENABLED;

  return (
    <>
      <AppBackdrop />
      <Nav />
      <main
        id="main-content"
        tabIndex={-1}
        data-deployment={process.env.DEPLOYMENT_VERSION || "unknown"}
        className="flex-1 px-3 pb-10 pt-0 sm:px-5 sm:py-6 lg:py-10"
      >
        <div className={marketEnabled ? "mx-auto w-full max-w-[900px]" : "site-shell"}>
          {marketEnabled ? <NativeBitcoinListingsPanel /> : <ComingSoonGate />}
        </div>
      </main>
      <Footer />
    </>
  );
}
