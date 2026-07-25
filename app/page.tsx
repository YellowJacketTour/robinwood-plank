import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import MintInfo from "@/components/MintInfo";
import NftViewer from "@/components/NftViewer";
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
        <MintInfo />
        <NftViewer />
        <Distribution />
        <Roadmap />
        <LiquidityBurn />
        <FAQGetReady />
      </main>
      <Footer />
    </>
  );
}
