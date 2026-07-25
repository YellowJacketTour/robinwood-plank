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
      <div className="relative mx-auto flex max-w-5xl flex-col items-center gap-3 text-center sm:gap-4">
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
          1,542 RobinWood NFTs · official trade widget · Good Wood vs Bad Boards
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

        <div className="flex w-full max-w-md flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
          <a
            href="#trade"
            className="rounded-lg bg-gold-500 px-6 py-2.5 text-sm font-bold text-wood-950 shadow-[0_6px_18px_-4px_rgba(217,164,65,0.5)] transition-all hover:-translate-y-0.5 sm:text-base"
          >
            Trade $PLANK
          </a>
          <a
            href="#boards"
            className="rounded-lg border-2 border-gold-500/50 bg-wood-900/80 px-6 py-2.5 text-sm font-bold text-gold-300 transition-colors hover:border-gold-400 sm:text-base"
          >
            Boards
          </a>
          <a
            href="#mint"
            className="rounded-lg border-2 border-forest-600 bg-forest-800/60 px-6 py-2.5 text-sm font-bold text-foreground transition-colors hover:border-gold-400 hover:text-gold-300 sm:text-base"
          >
            Mint
          </a>
        </div>
      </div>
    </section>
  );
}
