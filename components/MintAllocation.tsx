import Reveal from "@/components/Reveal";

const MINT_STATS = [
  {
    icon: "🪵",
    title: "777 Community",
    desc: "Free and Wood List mints share a protected pool of 777 NFTs.",
  },
  {
    icon: "💰",
    title: "765 Paid & Reserve",
    desc: "Paid and owner mints begin with a separate allocation of 765 NFTs.",
  },
  {
    icon: "🎯",
    title: "0.01 ETH",
    desc: "The paid mint price is read from the contract and shown live on the mint panel.",
  },
] as const;

/** Supply-split cards — sits below Your Planks so large collections don't push this up. */
export default function MintAllocation() {
  return (
    <section
      id="mint-allocation"
      aria-label="Mint allocation"
      className="scroll-mt-24 px-4 pb-8 pt-4 sm:px-6 sm:pb-10"
    >
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-3xl text-gold-300 sm:text-4xl">
            Mint Allocation
          </h2>
          <p className="lede mx-auto mt-2 max-w-2xl text-center text-foreground/70">
            How the 1,542 RobinWood supply is split.
          </p>
        </Reveal>

        <div className="mt-8 grid gap-5 sm:grid-cols-3 sm:gap-6">
          {MINT_STATS.map((stat, i) => (
            <Reveal key={stat.title} delayMs={i * 100}>
              <div className="wood-frame h-full rounded-2xl bg-wood-900/85 p-5 text-center sm:p-6">
                <div className="text-3xl sm:text-4xl" aria-hidden="true">
                  {stat.icon}
                </div>
                <h3 className="mt-3 font-display text-xl text-foreground sm:text-2xl">
                  {stat.title}
                </h3>
                <p className="mt-2 text-base text-foreground sm:text-lg">{stat.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
