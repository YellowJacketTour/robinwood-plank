import Reveal from "@/components/Reveal";

const STEPS = [
  {
    icon: "📲",
    step: "Step 1",
    title: "Send any EVM asset to your Robinhood Wallet address",
    desc: "Download the official Robinhood Wallet app and grab your public address. Since it's an EVM wallet, you can send ETH — or any EVM-chain asset — to that address from any exchange or wallet you already hold funds in.",
  },
  {
    icon: "🔁",
    step: "Step 2",
    title: "Use the in-app swap to convert to ETH on Robinhood Chain",
    desc: "Once funds land in your Robinhood Wallet, use the built-in in-app swap to cross-chain swap into ETH on Robinhood's L2 — no separate bridge site or contract to trust, it's handled inside the official app.",
  },
  {
    icon: "🌉",
    step: "Step 3",
    title: "Coming from a non-EVM chain? Swap first with ChangeNOW",
    desc: "Holding Bitcoin, Solana, or another non-EVM asset? Use a service like changenow.io to swap it into an EVM asset first, then send that to your Robinhood Wallet address and swap onto Robinhood Chain as in Step 2.",
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
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Getting ETH into your Robinhood Wallet on Robinhood Chain, before $PLANK goes live.
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
                <h3 className="mt-2 font-display text-xl text-foreground">{s.title}</h3>
                <p className="mt-2 text-sm text-foreground/70">{s.desc}</p>
              </li>
            </Reveal>
          ))}
        </ol>

        <Reveal delayMs={360}>
          <div className="mt-8 rounded-xl border-2 border-dashed border-gold-500/40 bg-forest-900/75 p-5 text-sm text-foreground/80">
            <p>
              <span aria-hidden="true">🔑</span> <strong>Golden Rule:</strong> Only ever download Robinhood Wallet
              from Robinhood&apos;s official site or your phone&apos;s app store, and triple-check your wallet address
              before sending funds. Fake wallet apps and copy-pasted wrong addresses are the #1 way people lose
              funds on new chain launches — never trust an address or app link from a tweet, DM, or Telegram.
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
