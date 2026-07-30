import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import MarketView from "@/components/market/MarketView";
import ComingSoonGate from "@/components/market/ComingSoonGate";
import { MARKET_ENABLED } from "@/lib/constants";
import { createPageMetadata } from "@/lib/seo";

/** Short ISR so dual-vault Instant Swap UI is not stuck behind year-long HTML cache. */
export const revalidate = 30;

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
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-10 sm:px-5">
        {/* Browsing a listing grid benefits from real desktop width — the
            site-wide 64rem prose column (.site-shell) is right for the
            marketing/coming-soon state but starves the grid on wide
            monitors once the market is live. */}
        <div className={MARKET_ENABLED ? "mx-auto w-full max-w-[1800px]" : "site-shell"}>
          {MARKET_ENABLED ? <MarketView /> : <ComingSoonGate />}
        </div>
      </main>
      <Footer />
    </>
  );
}
