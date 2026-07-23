import Reveal from "@/components/Reveal";

const FUNDING_FLOW = [
  {
    step: "1",
    title: "First 4.2069 ETH raised",
    value: "Initial LP",
    description:
      "100% of the first 4.2069 ETH in paid mint proceeds is used to establish liquidity.",
  },
  {
    step: "+",
    title: "Developer contribution",
    value: "1 ETH",
    description:
      "The developer adds 1 ETH of liquidity regardless of how much the mint raises.",
  },
  {
    step: "2",
    title: "Proceeds above 4.2069 ETH",
    value: "Ongoing support",
    description:
      "Any paid mint proceeds above 4.2069 ETH are used for buybacks and additional liquidity.",
  },
] as const;

export default function Distribution() {
  return (
    <section id="tokenomics" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">
            Mint Proceeds
          </h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            How paid mint proceeds and the developer contribution support liquidity.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {FUNDING_FLOW.map((item, index) => (
            <Reveal key={item.title} delayMs={index * 100}>
              <article className="wood-frame h-full rounded-2xl bg-wood-900/90 p-6">
                <div className="flex items-center justify-between gap-4">
                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-gold-500 font-display text-xl text-wood-950"
                  >
                    {item.step}
                  </span>
                  <span className="text-right text-sm font-extrabold uppercase tracking-wide text-gold-300">
                    {item.value}
                  </span>
                </div>
                <h3 className="mt-6 font-display text-xl text-foreground">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-foreground/70">{item.description}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delayMs={320}>
          <p className="lede mx-auto mt-8 max-w-3xl text-center text-sm text-foreground/65">
            The 1 ETH developer contribution is separate from mint proceeds. No fixed percentage of
            the total raise is represented here.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
