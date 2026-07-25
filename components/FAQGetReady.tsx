import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";

const STEPS = [
  {
    icon: "📲",
    step: "1",
    title: "Robinhood Wallet",
    desc: "Copy your public address.",
  },
  {
    icon: "🔁",
    step: "2",
    title: "ETH on RH Chain",
    desc: "In-app swap to chain 4663.",
  },
  {
    icon: "🌉",
    step: "3",
    title: "Verify network",
    desc: "Chain ID 4663 · gas in ETH.",
  },
];

export default function FAQGetReady() {
  return (
    <section id="get-ready" className="section-tight px-3 sm:px-5">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <SectionHead
            eyebrow="Guide"
            title="Get Mint-Ready"
            lede="Wallet · Robinhood Chain · ETH."
            artSrc="/images/collection/plank-bobawood.png"
            artAlt="BobaWood collection plank"
          />
        </Reveal>

        <ol className="mt-3 grid gap-2 sm:grid-cols-3 sm:gap-3">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delayMs={i * 80}>
              <li className="dense-card relative flex flex-col items-center p-2.5 text-center sm:p-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-gold-500 bg-wood-950 text-xl"
                  aria-hidden="true"
                >
                  {s.icon}
                </div>
                <span className="mt-1.5 text-[0.6rem] font-bold uppercase tracking-widest text-gold-300">
                  {s.step}
                </span>
                <h3 className="mt-0.5 font-display text-base text-foreground sm:text-lg">{s.title}</h3>
                <p className="mt-0.5 text-xs text-foreground/70">{s.desc}</p>
              </li>
            </Reveal>
          ))}
        </ol>

        <Reveal delayMs={200}>
          <div className="mt-3 rounded-lg border border-dashed border-gold-500/40 bg-forest-900/75 px-3 py-2 text-xs text-foreground/80">
            <strong>Stay safe:</strong> Official wallet only. Verify addresses. Ignore DMs.
          </div>
        </Reveal>
      </div>
    </section>
  );
}
