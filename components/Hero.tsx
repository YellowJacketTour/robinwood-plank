import Image from "next/image";
import CopyCA from "@/components/CopyCA";
import Countdown from "@/components/Countdown";

export default function Hero() {
  return (
    <section id="home" className="relative overflow-hidden px-3 pb-8 pt-14 sm:px-5 sm:pb-10 sm:pt-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(217,164,65,0.15),transparent_55%)]"
      />
      <div className="site-shell relative flex flex-col items-center gap-2.5 text-center sm:gap-3">
        <span className="rounded-full border border-gold-500/40 bg-wood-950/70 px-3 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest text-gold-300 backdrop-blur-sm">
          Robinhood Chain · live
        </span>

        <div className="flex items-center gap-3 sm:gap-4">
          <Image
            src="/images/plank-logo.webp"
            alt="RobinWood Plank mascot"
            width={96}
            height={140}
            priority
            className="h-16 w-auto drop-shadow-[0_8px_20px_rgba(0,0,0,0.5)] sm:h-20"
          />
          <div className="text-left">
            <h1 className="font-display text-3xl leading-none text-foreground sm:text-5xl md:text-6xl">
              RobinWood{" "}
              <span className="plank-title">($PLANK)</span>
            </h1>
            <p className="lede mt-1 font-display text-lg text-gold-300 sm:text-xl">Plank is Plank.</p>
          </div>
        </div>

        <Countdown targetDate={process.env.NEXT_PUBLIC_MINT_START_AT} />

        <p className="lede max-w-xl text-balance text-sm text-foreground sm:text-base">
          1,542 RobinWood NFTs · trade on Uniswap
        </p>

        <div className="wood-frame relative aspect-[2/1] w-full max-w-3xl overflow-hidden rounded-xl sm:aspect-[3110/2265]">
          <Image
            src="/images/planks-collage.jpg"
            alt="RobinWood Plank collection collage"
            fill
            priority
            sizes="(min-width: 1024px) 768px, 100vw"
            className="object-cover object-top"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent"
          />
        </div>

        <CopyCA />

        <div className="grid w-full max-w-lg grid-cols-2 gap-2 sm:flex sm:max-w-none sm:justify-center">
          <a
            href="#trade"
            className="col-span-2 rounded-lg bg-gold-500 px-5 py-2.5 text-center text-sm font-bold text-wood-950 sm:col-span-1 sm:min-w-[9rem]"
          >
            Trade
          </a>
          <a
            href="/market"
            className="rounded-lg border border-gold-500/50 bg-wood-900/80 px-4 py-2.5 text-center text-sm font-bold text-gold-300 sm:min-w-[9rem]"
          >
            Market
          </a>
          <a
            href="#mint"
            className="rounded-lg border border-forest-600 bg-forest-800/60 px-4 py-2.5 text-center text-sm font-bold text-foreground sm:min-w-[9rem]"
          >
            Mint
          </a>
        </div>
      </div>
    </section>
  );
}
