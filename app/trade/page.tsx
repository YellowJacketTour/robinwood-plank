import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import TradePageHeader from "@/components/trade/TradePageHeader";
import TradeWorkbench from "@/components/trade/TradeWorkbench";
import TradeStatusPanel from "@/components/trade/TradeStatusPanel";
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
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-6 sm:px-5 sm:py-10">
        {/* Same finalized-mockup shell cap as /market: min(1440px, 100% - 32px).
            data-market-shell keeps DESIGN.md tokens (border-line, bg-panel,
            text-cream…) authoritative against the marketing-page clamps in
            app/globals.css. */}
        <div data-market-shell className="mx-auto w-full max-w-[1440px] space-y-4 sm:space-y-6">
          <TradePageHeader />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start sm:gap-5">
            <div className="min-w-0 space-y-4 sm:space-y-5">
              <div className="mx-auto w-full max-w-xl">
                <TradeWorkbench />
              </div>
            </div>

            <div className="space-y-4 sm:space-y-5">
              <TradeStatusPanel />
              <TradeSafetyNotes />
            </div>
          </div>

          {/* $PLANK/ETH price chart mounts here (full shell width, below the
              workbench) once it lands — see task "plank price chart". */}
        </div>
      </main>
      <Footer />
    </>
  );
}
