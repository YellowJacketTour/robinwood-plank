import { cookies } from "next/headers";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import ComingSoonGate from "@/components/market/ComingSoonGate";
import { MARKET_ENABLED, GLOBAL_MARKET_ENABLED } from "@/lib/constants";
import { getContent } from "@/lib/content-store";
import type { FlagsDoc } from "@/lib/content-docs";
import { createPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";
import { verifyPreviewCookieValue, MARKET_PREVIEW_COOKIE_NAME } from "@/lib/market-preview-auth";
import { MARKET_VENUES, type MarketFamily, type MarketCoverage } from "@/lib/market/multichain/venue-registry";

/**
 * Public, honest known-limitations page for the Global (cross-chain)
 * market -- direct response to the 2026-08-25 critical alpha-readiness
 * audit's MEDIUM finding: ~30+ "planned / out of scope / honestly
 * documented" gaps exist across the discovery/trading code, individually
 * reasonable, but invisible to anyone except someone reading source. This
 * surfaces the same coverage data developers already see in
 * venue-registry.ts, plainly, to visitors -- not fixing the gaps, making
 * them visible instead of silently discoverable-by-source-reading only.
 *
 * Same market kill-switch as every other /market/multichain route.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = createPageMetadata({
  title: "Known Limitations — Global Market — Marketplank",
  description: "Honest, current coverage status for every chain and venue the Global market aggregates.",
  path: "/market/multichain/known-limitations",
  keywords: ["Marketplank", "known limitations", "coverage status"],
});

const COVERAGE_LABEL: Record<MarketCoverage, string> = {
  indexed: "Indexed",
  partial: "Partial",
  planned: "Planned — not built yet",
  unavailable: "Unavailable",
};

const COVERAGE_ORDER: Record<MarketCoverage, number> = {
  indexed: 0,
  partial: 1,
  planned: 2,
  unavailable: 3,
};

const COVERAGE_STYLE: Record<MarketCoverage, string> = {
  indexed: "border-emerald-500/50 bg-emerald-500/10 text-emerald-300",
  partial: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  planned: "border-line-strong bg-panel text-foreground/60",
  unavailable: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

const FAMILY_LABEL: Record<MarketFamily, string> = {
  evm: "EVM chains",
  solana: "Solana",
  bitcoin: "Bitcoin Ordinals",
};

const FAMILY_ORDER: MarketFamily[] = ["evm", "solana", "bitcoin"];

function VenueTable({ family }: { family: MarketFamily }) {
  const venues = MARKET_VENUES.filter((v) => v.family === family)
    .slice()
    .sort((a, b) => COVERAGE_ORDER[a.coverage] - COVERAGE_ORDER[b.coverage]);
  if (venues.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="font-display text-xl text-gold-300">{FAMILY_LABEL[family]}</h2>
      <div className="space-y-2">
        {venues.map((v) => (
          <div key={v.id} className="wood-ledger space-y-1.5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-bold text-cream">{v.label}</span>
              <span
                className={`inline-flex min-h-6 items-center rounded-md border px-2 text-[0.65rem] font-black uppercase tracking-wide ${COVERAGE_STYLE[v.coverage]}`}
              >
                {COVERAGE_LABEL[v.coverage]}
              </span>
            </div>
            <p className="text-xs text-cream-muted">{v.notes}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default async function KnownLimitationsPage() {
  const flags = (await getContent("flags").catch(() => null)) as FlagsDoc | null;
  const siteWideEnabled = flags && flags.marketEnabled !== null ? flags.marketEnabled : MARKET_ENABLED;
  const previewCookie = (await cookies()).get(MARKET_PREVIEW_COOKIE_NAME)?.value;
  const marketEnabled = (siteWideEnabled && GLOBAL_MARKET_ENABLED) || verifyPreviewCookieValue(previewCookie);

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
        <div className={marketEnabled ? "mx-auto w-full max-w-3xl space-y-6" : "site-shell"}>
          {marketEnabled ? (
            <>
              <div className="space-y-2">
                <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.28em] text-gold-300/90">Global market</p>
                <h1 className="font-display text-3xl text-gold-300">Known limitations</h1>
                <p className="text-sm text-cream-muted">
                  Every chain and venue below is at a genuinely different stage of coverage. This page lists them
                  plainly instead of leaving that only discoverable by reading source code — a collection on a{" "}
                  <strong className="text-cream">Planned</strong> venue may show thinner data than one on an{" "}
                  <strong className="text-cream">Indexed</strong> one, and that&apos;s a real, current limitation, not
                  a bug.
                </p>
              </div>
              {FAMILY_ORDER.map((family) => (
                <VenueTable key={family} family={family} />
              ))}
              <p className="text-xs text-cream-muted/70">
                Coverage state reflects this deployment&apos;s current build. It changes as venues are added or
                proven out — this page is generated from the same registry the app itself reads, not a separate
                claim.
              </p>
            </>
          ) : (
            <ComingSoonGate />
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
