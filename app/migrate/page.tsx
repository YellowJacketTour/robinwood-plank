import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import MigrateView from "@/components/market/MigrateView";
import ComingSoonGate from "@/components/market/ComingSoonGate";
import { MARKET_ENABLED } from "@/lib/constants";
import { getContent } from "@/lib/content-store";
import type { FlagsDoc } from "@/lib/content-docs";
import { createPageMetadata } from "@/lib/seo";

/**
 * Guided vault migration (V1 & V2 → the current vault). Dynamic like /market so
 * an immutable release switch never serves a stale layout, and so the admin
 * Flags override can gate it without a redeploy.
 */
export const dynamic = "force-dynamic";

export const metadata = createPageMetadata({
  title: "Migrate your planks",
  description:
    "Move your RobinWood planks out of Driftwood and WormWood into Premium Plank Liquidity — redeem on the older pool, deposit on the new. Same fees, no migration tax.",
  path: "/migrate",
  keywords: ["RobinWood vault migration", "Marketplank migrate", "plank vault upgrade"],
});

export default async function MigratePage() {
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
        className="flex-1 px-3 py-6 sm:px-5 sm:py-10"
        data-deployment={process.env.DEPLOYMENT_VERSION || "unknown"}
      >
        <div className={marketEnabled ? "mx-auto w-full max-w-[1220px]" : "site-shell"}>
          {marketEnabled ? <MigrateView /> : <ComingSoonGate />}
        </div>
      </main>
      <Footer />
    </>
  );
}
