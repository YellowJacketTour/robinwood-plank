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
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";

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
        <section id="gallery" className="section-tight scroll-mt-20 px-3 sm:px-5">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <SectionHead
                eyebrow="Live rarity · revealed only"
                title="Gallery"
                lede="Minted art, live rarity, trait stats — every Plank, ranked."
                center
                framed
                className="mx-auto max-w-2xl"
              />
            </Reveal>
            <Reveal delayMs={60}>
              <div className="mt-6 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
                <GalleryTeaser />
                <WalletLookupCard />
              </div>
            </Reveal>
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
