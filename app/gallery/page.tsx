import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AppBackdrop from "@/components/AppBackdrop";
import Gallery from "@/components/Gallery";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Gallery & Rarity",
  description:
    "Live gallery of minted RobinWood Planks with real-time rarity scores, trait analytics, and wallet search on Robinhood Chain.",
  path: "/gallery",
  keywords: ["RobinWood gallery", "RobinWood rarity", "RobinWood NFT traits"],
});

export default function GalleryPage() {
  return (
    <>
      <AppBackdrop />
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <Gallery />
      </main>
      <Footer />
    </>
  );
}
