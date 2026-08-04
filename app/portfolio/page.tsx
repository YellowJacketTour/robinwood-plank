import { Suspense } from "react";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import PortfolioView from "@/components/market/PortfolioView";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Portfolio",
  description:
    "Wallet-level vault PnL — weighted-average cost basis, realized/unrealized gains, and NAV-based current value across every RobinWood vault.",
  path: "/portfolio",
  keywords: ["RobinWood portfolio", "vault PnL", "plank.love portfolio"],
});

export default function PortfolioPage() {
  return (
    <>
      <AppBackdrop />
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <Suspense fallback={null}>
          <PortfolioView />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
