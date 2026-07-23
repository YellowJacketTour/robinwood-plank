import Image from "next/image";
import CopyCA from "@/components/CopyCA";

export default function Hero() {
  return (
    <section id="home" className="relative overflow-hidden px-4 pb-20 pt-16 sm:px-6 sm:pt-24">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(217,164,65,0.15),transparent_55%)]"
      />
      <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-10 text-center">
        <span className="rounded-full border border-gold-500/40 bg-wood-950/70 px-4 py-1 text-xs font-bold uppercase tracking-widest text-gold-300 backdrop-blur-sm">
          Robinhood Chain is live
        </span>

        <Image
          src="/images/plank-logo.webp"
          alt="RobinWood Plank mascot"
          width={140}
          height={200}
          priority
          className="h-28 w-auto drop-shadow-[0_8px_20px_rgba(0,0,0,0.5)] sm:h-36"
        />

        <h1 className="font-display text-5xl leading-tight text-foreground drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)] sm:text-6xl md:text-7xl">
          RobinWood <span className="gold-text drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">($PLANK)</span>
        </h1>

        <p className="lede font-display text-2xl text-gold-300 sm:text-3xl">Plank is Plank.</p>

        <p className="lede max-w-2xl text-balance text-xl text-foreground sm:text-2xl">
          1,542 RobinWood NFTs. Built for $PLANK.
        </p>

        <div className="wood-frame relative aspect-[3110/2265] w-full max-w-4xl overflow-hidden rounded-2xl">
          <Image
            src="/images/planks-collage.jpg"
            alt="RobinWood Plank mascot dressed as dozens of meme and pop-culture characters"
            fill
            priority
            sizes="(min-width: 1024px) 896px, 100vw"
            className="object-cover"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent sm:bg-gradient-to-t sm:from-black/50 sm:via-transparent sm:to-transparent"
          />
        </div>

        <CopyCA />

        <div className="flex flex-col gap-4 sm:flex-row">
          <a
            href="#mint"
            className="rounded-lg bg-gold-500 px-8 py-3 text-base font-bold text-wood-950 shadow-[0_6px_18px_-4px_rgba(217,164,65,0.5)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_-6px_rgba(217,164,65,0.6)] active:translate-y-0"
          >
            Mint RobinWood
          </a>
          <a
            href="#tokenomics"
            className="rounded-lg border-2 border-forest-600 bg-forest-800/60 px-8 py-3 text-base font-bold text-foreground transition-colors hover:border-gold-400 hover:text-gold-300"
          >
            Funding Details
          </a>
        </div>
      </div>
    </section>
  );
}
