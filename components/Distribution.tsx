import Reveal from "@/components/Reveal";

const FUNDING_FLOW = [
  {
    step: "1",
    title: "First 4.2069 ETH raised",
    value: "Initial LP",
    description:
      "100% goes to initial liquidity.",
  },
  {
    step: "+",
    title: "Developer contribution",
    value: "1 ETH",
    description:
      "Added regardless of the raise.",
  },
  {
    step: "2",
    title: "Proceeds above 4.2069 ETH",
    value: "Ongoing support",
    description:
      "Used for buybacks and more liquidity.",
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
            Simple. Fixed. Public.
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
                <h3 className="mt-6 font-display text-2xl text-foreground">{item.title}</h3>
                <p className="mt-3 text-lg leading-7 text-foreground">{item.description}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delayMs={320}>
          <p className="lede mx-auto mt-8 max-w-3xl text-center text-sm text-foreground/65">
            Developer ETH is separate from mint proceeds.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
