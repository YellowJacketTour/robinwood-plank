import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";

const FUNDING_FLOW = [
  {
    step: "1",
    title: "First 4.2069 ETH raised",
    value: "Initial LP",
    description: "100% to initial liquidity.",
  },
  {
    step: "+",
    title: "Developer contribution",
    value: "1 ETH",
    description: "Added regardless of raise.",
  },
  {
    step: "2",
    title: "Proceeds above 4.2069 ETH",
    value: "Ongoing support",
    description: "Buybacks + more liquidity.",
  },
] as const;

export default function Distribution() {
  return (
    <section id="tokenomics" className="section-tight px-3 sm:px-5">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <SectionHead
            eyebrow="Fixed. Public."
            title="Mint Proceeds"
            lede="Simple, transparent flow from every mint to on-chain liquidity."
            center
            className="mx-auto max-w-2xl"
          />
        </Reveal>

        <div className="mt-5 grid gap-3 sm:mt-6 sm:gap-4 md:grid-cols-3">
          {FUNDING_FLOW.map((item, index) => (
            <Reveal key={item.title} delayMs={index * 100}>
              <article className="wood-grain-surface h-full rounded-xl border border-line bg-panel p-4 sm:p-5">
                <div className="flex items-center justify-between gap-4">
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-gold-500 font-display text-lg text-wood-950"
                  >
                    {item.step}
                  </span>
                  <span className="text-right text-[0.68rem] font-extrabold uppercase tracking-[0.12em] text-gold-300">
                    {item.value}
                  </span>
                </div>
                <h3 className="mt-4 font-display text-lg text-cream sm:text-xl">{item.title}</h3>
                <p className="mt-1 text-sm text-cream-muted">{item.description}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delayMs={320}>
          <p className="mx-auto mt-4 max-w-3xl text-center text-[0.8rem] text-cream-muted sm:mt-5">
            Developer ETH is separate from mint proceeds.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
