import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import DiscoverView from "@/components/discover/DiscoverView";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Discover",
  description:
    "Search and filter every RobinWood collection by trait, rarity, and price — with a live Trending Collections rail.",
  path: "/discover",
  keywords: ["RobinWood discovery", "RobinWood trait search", "RobinWood trending collections"],
});

export default function DiscoverPage() {
  return (
    <>
      <AppBackdrop />
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <DiscoverView />
      </main>
      <Footer />
    </>
  );
}
