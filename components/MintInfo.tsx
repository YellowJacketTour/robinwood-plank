import Reveal from "@/components/Reveal";
import MintPanel from "@/components/MintPanel";
import MarketSnapshot from "@/components/MarketSnapshot";

export default function MintInfo() {
  return (
    <section id="mint" className="section-tight px-3 sm:px-5">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <p className="lede text-center text-[0.68rem] font-black uppercase tracking-[0.24em] text-gold-300/90">
            1,542 / 1,542 claimed
          </p>
          <h2 className="section-title mt-1 text-center text-4xl text-gold-300 sm:text-5xl">
            The Woodpile Is Full
          </h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Minting is closed for good — every Plank is already in a wallet. Buy or trade one on
            Marketplank.
          </p>
        </Reveal>

        <Reveal delayMs={80}>
          <div className="mx-auto mt-8 grid max-w-5xl items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.55fr)]">
            <MintPanel />
            <MarketSnapshot />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
