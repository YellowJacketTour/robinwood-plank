import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Gallery from "@/components/Gallery";
import { SITE_URL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Gallery & Rarity — RobinWood ($PLANK)",
  description:
    "Live gallery of minted RobinWood Planks with real-time rarity scores, trait analytics, and wallet search on Robinhood Chain.",
  openGraph: {
    title: "RobinWood Gallery & Rarity",
    description: "Revealed art, live rarity ranks, and trait insights.",
    url: `${SITE_URL}/gallery`,
  },
};

export default function GalleryPage() {
  return (
    <>
      <Nav />
      <main className="flex-1">
        <Gallery />
      </main>
      <Footer />
    </>
  );
}
