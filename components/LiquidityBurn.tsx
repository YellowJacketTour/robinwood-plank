import Reveal from "@/components/Reveal";

const SOURCES = [
  {
    icon: "💎",
    title: "1 ETH — Dev Seed",
    desc: "The dev wallet seeds the pool directly with 1 ETH, day one, no strings attached.",
  },
  {
    icon: "🪵",
    title: "RobinWood Mint Proceeds",
    desc: "45% of every paid RobinWood NFT mint flows straight into the $PLANK initial pool.",
  },
];

export default function LiquidityBurn() {
  return (
    <section id="liquidity" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <p className="lede text-center text-xs font-extrabold uppercase tracking-[0.3em] text-forest-600">
            The Golden Rule of $PLANK
          </p>
          <h2 className="section-title mt-2 text-center text-4xl text-gold-300 sm:text-5xl md:text-6xl">
            Liquidity Gets Burned. Forever.
          </h2>
          <p className="lede mx-auto mt-4 max-w-2xl text-center text-base text-foreground/80 sm:text-lg">
            No rug. No pulling the pool. Once liquidity is live, the LP tokens are sent to a dead
            address — permanently, irreversibly, un-ruggable by anyone, including us.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {SOURCES.map((s, i) => (
            <Reveal key={s.title} delayMs={i * 120}>
              <div className="wood-frame h-full rounded-2xl bg-wood-900/85 p-6 text-center">
                <div className="text-4xl" aria-hidden="true">
                  {s.icon}
                </div>
                <h3 className="mt-4 font-display text-xl text-foreground">{s.title}</h3>
                <p className="mt-2 text-sm text-foreground/70">{s.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delayMs={280}>
          <div className="mt-8 flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-gold-500/50 bg-forest-900/70 p-8 text-center backdrop-blur-sm">
            <div className="lede flex items-center gap-3 text-2xl font-extrabold uppercase tracking-wide text-gold-300 sm:text-3xl">
              <span aria-hidden="true">🔥</span>
              <span>Both go into the Uniswap $PLANK/ETH pool — then the LP is burned</span>
              <span aria-hidden="true">🔥</span>
            </div>
            <p className="lede max-w-2xl text-sm text-foreground/70">
              The dev&apos;s 1 ETH and the 45% of mint proceeds combine to seed the Uniswap
              $PLANK/ETH pool. The resulting LP tokens are burned on-chain, not held in any wallet —
              anyone will be able to verify the burn transaction once the pool is live.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
