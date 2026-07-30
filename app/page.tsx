import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import TrustFacts from "@/components/TrustFacts";
import Trade from "@/components/Trade";
import MintInfo from "@/components/MintInfo";
import MintAllocation from "@/components/MintAllocation";
import GalleryTeaser from "@/components/GalleryTeaser";
import WalletLookupCard from "@/components/WalletLookupCard";
import AirdropChecker from "@/components/AirdropChecker";
import Distribution from "@/components/Distribution";
import Roadmap from "@/components/Roadmap";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <Hero />
        {/* Trust facts moved directly under the hero CTA row (CRO rationale:
            answer "is this a rug" in the same viewport as the ask). */}
        <TrustFacts />
        <Trade />
        {/* Sold-out provenance panel — collection is fully minted, every
            conversion path here routes to Marketplank. */}
        <MintInfo />
        <MintAllocation />
        <section id="gallery" className="scroll-mt-20 px-3 py-10 sm:px-5 sm:py-12">
          <div className="mx-auto max-w-6xl">
            <div className="mb-4 text-center">
              <p className="lede text-[0.68rem] font-black uppercase tracking-[0.24em] text-gold-300/90">
                Live rarity · revealed only
              </p>
              <h2 className="section-title mt-1 text-gold-300">Gallery</h2>
              <p className="lede mx-auto mt-1 max-w-xl text-sm text-foreground/70 sm:text-base">
                Minted art, live rarity, trait stats — every Plank, ranked.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
              <GalleryTeaser />
              <WalletLookupCard />
            </div>
          </div>
        </section>
        <AirdropChecker />
        <Distribution />
        <Roadmap />
      </main>
      <Footer />
    </>
  );
}
