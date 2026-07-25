import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";

const SOURCES = [
  {
    icon: "💎",
    title: "1 ETH — Dev LP",
    desc: "Seeded regardless of raise.",
  },
  {
    icon: "🪵",
    title: "First 4.2069 ETH",
    desc: "100% into the pool.",
  },
];

export default function LiquidityBurn() {
  return (
    <section id="liquidity" className="section-tight scroll-mt-20 px-3 sm:px-5">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <SectionHead
            eyebrow="$PLANK liquidity"
            title="LP Gets Burned. Forever."
            lede="Initial LP tokens to the dead address — no rug path."
            artSrc="/images/plank-check-signed.jpg"
            artAlt="Bank of Plank novelty check"
          />
        </Reveal>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 sm:gap-3">
          {SOURCES.map((s, i) => (
            <Reveal key={s.title} delayMs={i * 80}>
              <div className="dense-card flex items-center gap-3 p-3 sm:p-3.5">
                <span className="text-2xl" aria-hidden="true">
                  {s.icon}
                </span>
                <div className="min-w-0">
                <h3 className="font-display text-base text-foreground sm:text-lg">{s.title}</h3>
                <p className="text-xs text-foreground/70 sm:text-sm">{s.desc}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delayMs={160}>
          <div className="mt-3 rounded-lg border border-dashed border-gold-500/45 bg-forest-900/70 px-3 py-2.5 text-center">
            <p className="text-xs font-extrabold uppercase tracking-wide text-gold-300 sm:text-sm">
              🔥 Fund LP · burn initial LP tokens · verify on-chain 🔥
            </p>
            <p className="mt-0.5 text-[0.7rem] text-foreground/65">
              Above 4.2069 ETH: buybacks + more LP.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
