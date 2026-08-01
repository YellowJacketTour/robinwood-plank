import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import FloorboardsView from "@/components/market/FloorboardsView";
import ComingSoonGate from "@/components/market/ComingSoonGate";
import { MARKET_ENABLED } from "@/lib/constants";
import { getContent } from "@/lib/content-store";
import type { FlagsDoc } from "@/lib/content-docs";
import { createPageMetadata } from "@/lib/seo";

/**
 * "Under the floorboards" is a live application shell like /market — keep it
 * dynamic so a release switch or the admin kill flag both take effect without a
 * redeploy.
 */
export const dynamic = "force-dynamic";

export const metadata = createPageMetadata({
  title: "Under the floorboards",
  description:
    "Shop the honest floor: pull RobinWood planks out of the V1 vault below listed floor price.",
  path: "/floorboards",
  keywords: ["RobinWood floor", "plank arbitrage", "Marketplank V1 vault"],
});

export default async function FloorboardsPage() {
  // Shares the market kill switch — the floorboards are a market surface, so
  // when the marketplace is gated off this page is too.
  const flags = (await getContent("flags").catch(() => null)) as FlagsDoc | null;
  const marketEnabled =
    flags && flags.marketEnabled !== null ? flags.marketEnabled : MARKET_ENABLED;

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
          {marketEnabled ? <FloorboardsView /> : <ComingSoonGate />}
        </div>
      </main>
      <Footer />
    </>
  );
}
