import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import GlobalMarketHub from "@/components/market/GlobalMarketHub";
import ComingSoonGate from "@/components/market/ComingSoonGate";
import { MARKET_ENABLED } from "@/lib/constants";
import { getContent } from "@/lib/content-store";
import type { FlagsDoc } from "@/lib/content-docs";
import { createPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

/**
 * The "global market world" -- every tracked collection across every
 * foreign chain, one click from Marketplank's own home-town RobinWood
 * plank surface (/market) and one click back. Same market kill-switch,
 * same shell as every other market route.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = createPageMetadata({
  title: "Global Market — Marketplank",
  description: "Browse, buy, sweep, and send NFTs across every chain Marketplank tracks.",
  path: "/market/multichain",
  keywords: ["Marketplank", "cross-chain NFT market", "global market"],
});

export default async function GlobalMarketPage() {
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
        <div className={marketEnabled ? "mx-auto w-full max-w-[1440px]" : "site-shell"}>
          {marketEnabled ? <GlobalMarketHub /> : <ComingSoonGate />}
        </div>
      </main>
      <Footer />
    </>
  );
}
