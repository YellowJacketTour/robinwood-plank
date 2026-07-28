import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import MarketView from "@/components/market/MarketView";
import ComingSoonGate from "@/components/market/ComingSoonGate";
import { MARKET_ENABLED, SITE_URL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Marketplank — RobinWood NFT Marketplace",
  description: "List, buy, sell, and make offers on RobinWood — and eventually any Robinhood Chain collection.",
  openGraph: {
    title: "Marketplank",
    description: "The RobinWood NFT marketplace on Robinhood Chain.",
    url: `${SITE_URL}/market`,
  },
};

export default function MarketPage() {
  return (
    <>
      <Nav />
      <main className="flex-1 px-3 py-10 sm:px-5">
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
