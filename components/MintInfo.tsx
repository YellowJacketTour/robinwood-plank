import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import MintPanel from "@/components/MintPanel";
import MarketSnapshot from "@/components/MarketSnapshot";
import MintAllocation from "@/components/MintAllocation";

export default function MintInfo() {
  return (
    <section id="mint" className="section-tight px-3 sm:px-5">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <SectionHead
            eyebrow="1,542 / 1,542 claimed"
            title="The Woodpile Is Full"
            lede="Minting is closed for good — every Plank is already in a wallet. Buy or trade one on Marketplank."
            center
            className="mx-auto max-w-2xl"
          />
        </Reveal>

        <Reveal delayMs={80}>
          <div className="mx-auto mt-8 grid max-w-5xl items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.55fr)]">
            <MintPanel />
            <MarketSnapshot />
          </div>
        </Reveal>

        {/* Supply split — part of this section per the mockup, not its own */}
        <div className="mx-auto max-w-5xl">
          <MintAllocation />
        </div>
      </div>
    </section>
  );
}
