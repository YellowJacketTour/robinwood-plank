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
              <li className="dense-card relative flex flex-col items-center p-3 text-center sm:p-4">
                <div
                  className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full border-2 border-gold-500 bg-wood-950 text-3xl"
                  aria-hidden="true"
                >
                  {s.icon}
                </div>
                <span className="mt-4 text-xs font-bold uppercase tracking-widest text-gold-300">{s.step}</span>
                <h3 className="mt-2 font-display text-2xl text-foreground">{s.title}</h3>
                <p className="mt-2 text-lg text-foreground">{s.desc}</p>
              </li>
            </Reveal>
          ))}
        </ol>

        <Reveal delayMs={360}>
          <div className="mt-8 rounded-xl border-2 border-dashed border-gold-500/40 bg-forest-900/75 p-5 text-sm text-foreground/80">
            <p>
              <span aria-hidden="true">🔑</span> <strong>Stay safe:</strong> Use the official wallet. Verify every
              address. Ignore links in DMs.
            </p>
          </div>
        </Reveal>

        <p className="mt-6 text-center text-xs italic text-foreground/50">
          Verify everything with Robinhood&apos;s official documentation.
        </p>
      </div>
    </section>
  );
}
