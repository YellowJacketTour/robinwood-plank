import Reveal from "@/components/Reveal";
import { WHITELIST_TWEET_URL } from "@/lib/constants";

const MINT_STATS = [
  {
    icon: "🆓",
    title: "50% Free Mint",
    desc: "Half the collection is free to claim — just cover gas on Robinhood Chain.",
  },
  {
    icon: "💰",
    title: "50% Paid Mint",
    desc: "The other half mints at 0.01 ETH, funding the treasury and the $PLANK pool.",
  },
  {
    icon: "🎯",
    title: "Goal: 4.2069 ETH",
    desc: "Our raise target — every mint pushes RobinWood closer to full send.",
  },
];

export default function MintInfo() {
  return (
    <section id="mint" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">Mint Structure</h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Simple, fair, and built to fund $PLANK liquidity from block one.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-6 sm:grid-cols-3">
          {MINT_STATS.map((stat, i) => (
            <Reveal key={stat.title} delayMs={i * 120}>
              <div className="wood-frame h-full rounded-2xl bg-wood-900/85 p-6 text-center">
                <div className="text-4xl" aria-hidden="true">
                  {stat.icon}
                </div>
                <h3 className="mt-4 font-display text-xl text-foreground">{stat.title}</h3>
                <p className="mt-2 text-sm text-foreground/70">{stat.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delayMs={200}>
          <div
            id="whitelist"
            className="mx-auto mt-14 max-w-2xl scroll-mt-24 rounded-2xl border-2 border-dashed border-gold-500/50 bg-forest-900/75 p-6 text-center"
          >
            <h3 className="font-display text-2xl text-gold-300">Join the Whitelist</h3>
            <p className="mt-2 text-sm text-foreground/70">
              Drop your wallet address in the replies to our official whitelist thread on X. No wallet
              connection needed on this page; this is an info-only site.
            </p>
            <a
              href={WHITELIST_TWEET_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-block rounded-lg bg-gold-500 px-8 py-3 text-base font-bold text-wood-950 shadow-[0_6px_18px_-4px_rgba(217,164,65,0.5)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_-6px_rgba(217,164,65,0.6)] active:translate-y-0"
            >
              Leave Your Address on X ↗
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
