import Reveal from "@/components/Reveal";
import MintPanel from "@/components/MintPanel";
import Image from "next/image";

export default function MintInfo() {
  return (
    <section id="mint" className="section-tight px-3 sm:px-5">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">
            Mint Structure
          </h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Live contract, live supply.
          </p>
        </Reveal>

        {/* Wood List / Wood Checker hidden — allow list closed */}

        <Reveal delayMs={80}>
          <div className="mx-auto mt-8 grid max-w-5xl items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.55fr)]">
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
      </div>
    </section>
  );
}
