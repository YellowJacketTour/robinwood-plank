import Reveal from "@/components/Reveal";

const STEPS = [
  {
    icon: "🏦",
    step: "Step 1",
    title: "In-app bridge (safest)",
    desc: "If Robinhood ships an in-app “Send to chain” or bridge feature, use it directly in the Robinhood app. Funds stay in Robinhood's custody until the official bridge contract moves them — no third-party contract risk.",
  },
  {
    icon: "🦊",
    step: "Step 2",
    title: "Self-custody wallet + official bridge",
    desc: "Withdraw ETH from Robinhood to a self-custody wallet (MetaMask, Rabby, etc.), then bridge to Robinhood Chain using only the bridge URL linked directly from Robinhood's own site or app — never a link from Twitter, Telegram, or a DM.",
  },
  {
    icon: "🏛️",
    step: "Step 3",
    title: "Direct CEX deposit (if supported)",
    desc: "Some new L2s get day-one deposit/withdraw support from major exchanges (Coinbase, Kraken, Binance). If Robinhood Chain is listed, this skips bridge risk entirely — just double-check the network name matches exactly before sending.",
  },
];

export default function FAQGetReady() {
  return (
    <section id="get-ready" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">
            How to Get $PLANK-Ready
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Getting your funds onto Robinhood Chain safely, before $PLANK goes live.
          </p>
        </Reveal>

        <ol className="mt-14 grid gap-8 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delayMs={i * 120}>
              <li className="relative flex flex-col items-center rounded-2xl border border-gold-500/20 bg-wood-900/60 p-6 text-center">
                <div
                  className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full border-2 border-gold-500 bg-wood-950 text-3xl"
                  aria-hidden="true"
                >
                  {s.icon}
                </div>
                <span className="mt-4 text-xs font-bold uppercase tracking-widest text-gold-300">{s.step}</span>
                <h3 className="mt-2 font-display text-xl text-foreground">{s.title}</h3>
                <p className="mt-2 text-sm text-foreground/70">{s.desc}</p>
              </li>
            </Reveal>
          ))}
        </ol>

        <Reveal delayMs={360}>
          <div className="mt-8 rounded-xl border-2 border-dashed border-gold-500/40 bg-forest-900/40 p-5 text-sm text-foreground/80">
            <p>
              <span aria-hidden="true">🔑</span> <strong>Golden Rule:</strong> Only ever use bridge or contract
              links posted on Robinhood&apos;s official domain or app. Fake bridge sites are the #1 drainer vector on
              new chain launches. Never trust a link from a tweet, DM, or Telegram.
            </p>
          </div>
        </Reveal>

        <p className="mt-6 text-center text-xs italic text-foreground/50">
          General safety guidance only — not financial advice. Always verify against Robinhood&apos;s official
          documentation before bridging funds.
        </p>
      </div>
    </section>
  );
}
