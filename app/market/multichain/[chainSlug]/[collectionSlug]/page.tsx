import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import MultichainCollectionView from "@/components/market/MultichainCollectionView";
import ComingSoonGate from "@/components/market/ComingSoonGate";
import { MARKET_ENABLED } from "@/lib/constants";
import { getContent } from "@/lib/content-store";
import type { FlagsDoc } from "@/lib/content-docs";
import { createPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

/**
 * Cross-chain collection browse + buy + sweep -- a NEW surface, distinct
 * from /market (Marketplank's own single RobinWood collection) and
 * /discover (ours-only, no venue badges). See
 * app/api/market/multichain/listings/route.ts's header for why this
 * couldn't live inside either of those existing, documented contracts.
 * Gated by the SAME market kill-switch as /market -- this is still
 * Marketplank trading infrastructure, not an independent product.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ chainSlug: string; collectionSlug: string }>;
}): Promise<Metadata> {
  const { chainSlug, collectionSlug } = await params;
  return createPageMetadata({
    title: `${collectionSlug} on ${chainSlug} — Marketplank`,
    description: "Browse and buy this collection's real listings across chains, verified fresh before every purchase.",
    path: `/market/multichain/${chainSlug}/${collectionSlug}`,
    keywords: ["Marketplank", "cross-chain NFT", chainSlug, collectionSlug],
  });
}

export default async function MultichainCollectionPage({
  params,
}: {
  params: Promise<{ chainSlug: string; collectionSlug: string }>;
}) {
  const { chainSlug, collectionSlug } = await params;
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
          {marketEnabled ? (
            <MultichainCollectionView chainSlug={chainSlug} collectionSlug={collectionSlug} />
          ) : (
            <ComingSoonGate />
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
