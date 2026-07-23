import Reveal from "@/components/Reveal";

const SOURCES = [
  {
    icon: "💎",
    title: "1 ETH — Developer Liquidity",
    desc: "Added regardless of the raise.",
  },
  {
    icon: "🪵",
    title: "First 4.2069 ETH Raised",
    desc: "100% goes into LP.",
  },
];

export default function LiquidityBurn() {
  return (
    <section id="liquidity" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <p className="lede text-center text-xs font-extrabold uppercase tracking-[0.3em] text-forest-600">
            $PLANK LIQUIDITY
          </p>
          <h2 className="section-title mt-2 text-center text-4xl text-gold-300 sm:text-5xl md:text-6xl">
            Liquidity Gets Burned. Forever.
          </h2>
          <p className="lede mx-auto mt-4 max-w-2xl text-center text-base text-foreground/80 sm:text-lg">
            Initial LP tokens go to the dead address.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {SOURCES.map((s, i) => (
            <Reveal key={s.title} delayMs={i * 120}>
              <div className="wood-frame h-full rounded-2xl bg-wood-900/85 p-6 text-center">
                <div className="text-4xl" aria-hidden="true">
                  {s.icon}
                </div>
                <h3 className="mt-4 font-display text-2xl text-foreground">{s.title}</h3>
                <p className="mt-2 text-lg text-foreground">{s.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delayMs={280}>
          <div className="mt-8 flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-gold-500/50 bg-forest-900/70 p-8 text-center backdrop-blur-sm">
            <div className="lede flex items-center gap-3 text-2xl font-extrabold uppercase tracking-wide text-gold-300 sm:text-3xl">
              <span aria-hidden="true">🔥</span>
              <span>Fund LP. Burn initial LP tokens.</span>
              <span aria-hidden="true">🔥</span>
            </div>
            <p className="lede max-w-2xl text-sm text-foreground/70">
              Above 4.2069 ETH: buybacks and added liquidity. Verify the initial LP burn on-chain.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
