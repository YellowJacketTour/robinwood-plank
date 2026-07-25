import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Trade from "@/components/Trade";
import WoodYouJustLookAtIt from "@/components/WoodYouJustLookAtIt";
import MintInfo from "@/components/MintInfo";
import Gallery from "@/components/Gallery";
import NftViewer from "@/components/NftViewer";
import MintAllocation from "@/components/MintAllocation";
import Distribution from "@/components/Distribution";
import Roadmap from "@/components/Roadmap";
import LiquidityBurn from "@/components/LiquidityBurn";
import FAQGetReady from "@/components/FAQGetReady";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main className="flex-1">
        <Hero />
        <Trade />
        <WoodYouJustLookAtIt />
        <MintInfo />
        <Gallery />
        <NftViewer />
        <MintAllocation />
        <Distribution />
        <Roadmap />
        <LiquidityBurn />
        <FAQGetReady />
      </main>
      <Footer />
    </>
  );
}
