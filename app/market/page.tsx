import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import MarketView from "@/components/market/MarketView";
import ComingSoonGate from "@/components/market/ComingSoonGate";
import { MARKET_ENABLED } from "@/lib/constants";
import { createPageMetadata } from "@/lib/seo";

/**
 * Marketplank is a live application shell, not publish-once content. Keeping
 * the route dynamic prevents Next.js and the hosting proxy from carrying an
 * old layout across an immutable release switch.
 */
export const dynamic = "force-dynamic";

export const metadata = createPageMetadata({
  title: "Marketplank NFT Marketplace",
  description:
    "Browse, list, buy, sell, make offers, and use Instant Swap for RobinWood NFTs on Robinhood Chain.",
  path: "/market",
  keywords: ["Marketplank", "RobinWood marketplace", "Robinhood Chain NFT marketplace"],
});

export default function MarketPage() {
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
        {/* Finalized mockup shell: min(1440px, 100% - 32px). Wider than the
            site's 64rem prose column so the grid gets desktop room, but
            capped — at ultrawide widths an uncapped workspace inflated every
            panel far past the approved composition. */}
        <div className={MARKET_ENABLED ? "mx-auto w-full max-w-[1440px]" : "site-shell"}>
          {MARKET_ENABLED ? <MarketView /> : <ComingSoonGate />}
        </div>
      </main>
      <Footer />
    </>
  );
}
