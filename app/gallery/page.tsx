import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Gallery from "@/components/Gallery";
import { SITE_URL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Gallery — RobinWood ($PLANK)",
  description:
    "Live gallery of every minted RobinWood Plank NFT on Robinhood Chain. Newest first, searchable by name and traits.",
  openGraph: {
    title: "RobinWood Gallery",
    description: "Revealed Plank art — latest mint first.",
    url: `${SITE_URL}/gallery`,
  },
};

export default function GalleryPage() {
  return (
    <>
      <Nav />
      <main className="flex-1">
        <div className="pt-4 sm:pt-6">
          <Gallery />
        </div>
      </main>
      <Footer />
    </>
  );
}
