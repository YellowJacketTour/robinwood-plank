import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import TradePageHeader from "@/components/trade/TradePageHeader";
import PlankPriceChart from "@/components/trade/PlankPriceChart";
import ChartErrorBoundary from "@/components/trade/ChartErrorBoundary";
import PlankPoolsPanel from "@/components/trade/PlankPoolsPanel";
import PlankValuation from "@/components/trade/PlankValuation";
import TradeActionZone from "@/components/trade/TradeActionZone";
import { createPageMetadata } from "@/lib/seo";

/** Trade status/countdown are live state, not publish-once content — same
 * reasoning as /market (app/market/page.tsx). */
export const dynamic = "force-dynamic";

export const metadata = createPageMetadata({
  title: "Trade $PLANK",
  description:
    "Buy and sell $PLANK on Robinhood Chain through the official, verified-contract Uniswap widget. Not a bridge — always the real $PLANK.",
  path: "/trade",
  keywords: ["$PLANK", "trade PLANK", "Uniswap", "Robinhood Chain", "buy PLANK", "sell PLANK"],
});

export default function TradePage() {
  return (
    <>
      <AppBackdrop />
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-6 sm:px-5 sm:py-10">
        {/* Same finalized-mockup shell cap as /market: min(1440px, 100% - 32px).
            data-market-shell keeps DESIGN.md tokens (border-line, bg-panel,
            text-cream…) authoritative against the marketing-page clamps in
            app/globals.css. */}
        <div data-market-shell className="mx-auto w-full max-w-[1440px] space-y-4 sm:space-y-6">
          <TradePageHeader />

          {/* Price context leads, ahead of the workbench — it's the first
              thing people look for landing on a trade page. Always visible
              (not nested inside the same-chain/cross-chain toggle), so it
              omits the `active` prop and just polls continuously. */}
          <ChartErrorBoundary>
            <PlankPriceChart />
          </ChartErrorBoundary>

          {/* Pools evidence sits immediately under the chart, not buried in
              the safety band. The chart discloses it only tracks the single
              deepest pool as its price reference — the very next thing on
              the page has to be the panel backing that disclosure with all
              five real venues, or the disclosure is a promise the visitor
              has to scroll to go verify instead of evidence already in view
              (docs/TRADE_PAGE_SPEC.md §1). */}
          <div className="mx-auto w-full max-w-4xl">
            <PlankPoolsPanel />
          </div>

          {/* Valuation sits AFTER the pools panel, not between it and the
              chart, because docs/TRADE_PAGE_SPEC.md §1 requires the pools
              evidence to be the very next thing under the chart's
              one-pool disclosure. It still reads as price context rather
              than action, so it stays above the workbench and shares the
              pools panel's max-w-4xl column.

              The chart's stat strip already surfaces a token-wide FDV tile;
              this panel is where that number gets its supply basis, its
              concentration disclosure, and its cross-check against both
              aggregators. See lib/plank-valuation.ts for why the page shows
              an FDV and never a circulating market cap. */}
          <div className="mx-auto w-full max-w-4xl">
            <PlankValuation />
          </div>

          {/* Action zone (workbench + status, capped at max-w-4xl so the
              fluid workbench column lands close to the rail — see
              TradeActionZone's own comment) and the safety band both live
              inside TradeActionZone now, because both need the one piece of
              state it owns: which TradeModeSwitch tab is active. The safety
              band specifically can't be correct without it — "Not a bridge"
              is only true in same-chain mode. */}
          <TradeActionZone />
        </div>
      </main>
      <Footer />
    </>
  );
}
