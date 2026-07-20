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
        <span className="rounded-full border border-gold-500/40 bg-gold-500/10 px-4 py-1 text-xs font-bold uppercase tracking-widest text-gold-300">
          Robinhood Chain is live
        </span>

        <h1 className="font-display text-5xl leading-tight text-foreground drop-shadow-[0_4px_0_rgba(0,0,0,0.4)] sm:text-6xl md:text-7xl">
          RobinWood <span className="gold-text">($PLANK)</span>
        </h1>

        <p className="font-display text-2xl text-gold-300 sm:text-3xl">Plank is Plank.</p>

        <p className="max-w-2xl text-balance text-base text-foreground/80 sm:text-lg">
          The Robinhood Chain is officially live. To celebrate, we&apos;re launching the{" "}
          <strong className="text-foreground">RobinWood NFT Collection</strong>, built to support{" "}
          <strong className="text-gold-300">$PLANK</strong> from day one.
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
            href="#whitelist"
            className="rounded-lg bg-gold-500 px-8 py-3 text-base font-bold text-wood-950 shadow-[0_6px_0_0_#a9781f] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[0_2px_0_0_#a9781f]"
          >
            Join the Whitelist
          </a>
          <a
            href="#tokenomics"
            className="rounded-lg border-2 border-forest-600 bg-forest-800/60 px-8 py-3 text-base font-bold text-foreground transition-colors hover:border-gold-400 hover:text-gold-300"
          >
            Read the Docs
          </a>
        </div>
      </div>
    </section>
  );
}
