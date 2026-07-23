import Reveal from "@/components/Reveal";

const STEPS = [
  {
    icon: "📲",
    step: "Step 1",
    title: "Open Robinhood Wallet",
    desc: "Copy your public wallet address.",
  },
  {
    icon: "🔁",
    step: "Step 2",
    title: "Get ETH on Robinhood Chain",
    desc: "Use the wallet's built-in swap.",
  },
  {
    icon: "🌉",
    step: "Step 3",
    title: "Verify the Network",
    desc: "Chain ID 4663. Gas is paid in ETH.",
  },
];

export default function FAQGetReady() {
  return (
    <section id="get-ready" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">
            Get Mint-Ready
          </h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Wallet. Robinhood Chain. ETH.
          </p>
        </Reveal>

        <ol className="mt-14 grid gap-8 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delayMs={i * 120}>
              <li className="relative flex flex-col items-center rounded-2xl border border-gold-500/20 bg-wood-900/85 p-6 text-center">
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
