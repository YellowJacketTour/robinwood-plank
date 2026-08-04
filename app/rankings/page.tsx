import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import RankingsView from "@/components/social/RankingsView";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Rankings",
  description: "Reputation-weighted community rankings for RobinWood collections.",
  path: "/rankings",
  keywords: ["RobinWood rankings", "RobinWood community endorsements", "RobinWood leaderboard"],
});

export default function RankingsPage() {
  return (
    <>
      <AppBackdrop />
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <RankingsView />
      </main>
      <Footer />
    </>
  );
}
