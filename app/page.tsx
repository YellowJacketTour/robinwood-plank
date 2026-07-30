import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Trade from "@/components/Trade";
import AirdropChecker from "@/components/AirdropChecker";
import MintInfo from "@/components/MintInfo";
import Gallery from "@/components/Gallery";
import NftViewer from "@/components/NftViewer";
import MintAllocation from "@/components/MintAllocation";
import Distribution from "@/components/Distribution";
import Roadmap from "@/components/Roadmap";
import TrustFacts from "@/components/TrustFacts";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <Hero />
        <Trade />
        {/* Mint prioritized until sellout — boards/airdrop sit below */}
        <MintInfo />
        <Gallery />
        <NftViewer />
        <MintAllocation />
        <AirdropChecker />
        <Distribution />
        <Roadmap />
        <TrustFacts />
      </main>
      <Footer />
    </>
  );
}
