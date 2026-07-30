import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import TradePageHeader from "@/components/trade/TradePageHeader";
import PlankPriceChart from "@/components/trade/PlankPriceChart";
import ChartErrorBoundary from "@/components/trade/ChartErrorBoundary";
import PlankPoolsPanel from "@/components/trade/PlankPoolsPanel";
import TradeActionZone from "@/components/trade/TradeActionZone";
import TradeSafetyNotes from "@/components/trade/TradeSafetyNotes";
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

          {/* Action zone: workbench + status read as one paired unit, capped
              narrower than the shell so the fluid workbench column lands
              close to the rail instead of stranding it across empty space
              (max-w-4xl minus the 320px rail leaves ~556px — almost exactly
              the workbench's own natural width). The chart above stays full
              width as the page's dominant visual; this row is the focused
              action beneath it. */}
          <div className="mx-auto w-full max-w-4xl">
            <TradeActionZone />
          </div>

          {/* Safety disclosures read as a full-width trust band beneath the
              action zone — same content as before, given room to breathe
              across four columns instead of stacked in a narrow rail. */}
          <TradeSafetyNotes />
        </div>
      </main>
      <Footer />
    </>
  );
}
