import Reveal from "@/components/Reveal";

const MINT_STATS = [
  {
    icon: "🪵",
    title: "777 Community",
    desc: "Free + Wood List pool.",
  },
  {
    icon: "💰",
    title: "765 Paid & Reserve",
    desc: "Paid + owner mints.",
  },
  {
    icon: "🎯",
    title: "0.01 ETH",
    desc: "Paid mint price.",
  },
] as const;

/** Supply-split cards — sits below Your Planks so large collections don't push this up. */
export default function MintAllocation() {
  return (
    <section
      id="mint-allocation"
      aria-label="Mint allocation"
      className="scroll-mt-20 px-3 pb-6 pt-2 sm:px-5 sm:pb-8"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-3xl text-gold-300 sm:text-4xl">
            Mint Allocation
          </h2>
          <p className="lede mx-auto mt-2 max-w-2xl text-center text-foreground/70">
            1,542 total supply, split three ways.
          </p>
        </Reveal>

        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-6">
          {MINT_STATS.map((stat, i) => (
            <Reveal key={stat.title} delayMs={i * 100}>
              <div className="wood-frame h-full rounded-2xl bg-wood-900/85 p-5 text-center sm:p-6">
                <div className="text-3xl sm:text-4xl" aria-hidden="true">
                  {stat.icon}
                </div>
                <h3 className="mt-3 font-display text-lg text-foreground sm:text-2xl">
                  {stat.title}
                </h3>
                <p className="mt-2 text-sm text-foreground/80 sm:text-lg">{stat.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
