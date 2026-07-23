import Reveal from "@/components/Reveal";
import MintPanel from "@/components/MintPanel";
import Image from "next/image";
import { WHITELIST_TWEET_URL } from "@/lib/constants";

const MINT_STATS = [
  {
    icon: "🪵",
    title: "777 Community",
    desc: "Free and allowlist mints share a protected pool of 777 NFTs.",
  },
  {
    icon: "💰",
    title: "765 Paid & Reserve",
    desc: "Paid and owner mints begin with a separate allocation of 765 NFTs.",
  },
  {
    icon: "🎯",
    title: "0.01 ETH",
    desc: "The paid mint price is read from the contract and shown live below.",
  },
];

export default function MintInfo() {
  return (
    <section id="mint" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">Mint Structure</h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Live supply, phase, pricing, and wallet limits are read directly from the mint contract.
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

        <Reveal delayMs={180}>
          <div className="mx-auto mt-10 grid max-w-5xl items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.55fr)]">
            <MintPanel />
            <div className="wood-frame relative hidden min-h-[520px] overflow-hidden rounded-2xl bg-wood-900/85 lg:block">
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(217,164,65,0.22),transparent_58%)]"
              />
              <Image
                src="/images/business-casual-swag.png"
                alt="RobinWood Plank in business casual"
                fill
                sizes="360px"
                className="relative object-contain p-5 drop-shadow-[0_24px_28px_rgba(0,0,0,0.55)]"
              />
            </div>
          </div>
        </Reveal>

        <Reveal delayMs={200}>
          <div
            id="whitelist"
            className="mx-auto mt-14 max-w-2xl scroll-mt-24 rounded-2xl border-2 border-dashed border-gold-500/50 bg-forest-900/75 p-6 text-center"
          >
            <h3 className="font-display text-2xl text-gold-300">Join the Whitelist</h3>
            <p className="mt-2 text-sm text-foreground/70">
              Drop your wallet address in the replies to our official whitelist thread on X. If selected,
              your wallet will be included when the allowlist root and proofs are published.
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
