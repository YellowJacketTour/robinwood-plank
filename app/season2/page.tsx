import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import PlankKothBoard from "@/components/market/PlankKothBoard";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Season 2 · Biggest Buyer Board",
  description:
    "The biggest single $PLANK buy over 31 days wins 0.69420% of total supply. Live board of biggest buys, fallen champions, and real anti-fraud verification on every buy.",
  path: "/season2",
  keywords: ["Biggest Buyer Board", "Season 2", "PLANK competition", "Board of Biggest Buys"],
});

export default function Season2Page() {
  return (
    <>
      <Nav />
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:py-14">
        <PlankKothBoard />
        <p className="text-center text-[0.7rem] text-foreground/45">
          Every buy is verified against the canonical $PLANK pools, real on-chain finality, and this
          platform&apos;s own fraud-detection pipeline before it can rank. Flagged buys are held for manual
          review, never silently promoted.
        </p>
      </main>
      <Footer />
    </>
  );
}
