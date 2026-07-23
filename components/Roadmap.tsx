import Image from "next/image";
import Reveal from "@/components/Reveal";

const PHASES = [
  {
    icon: "🌱",
    phase: "Phase 1 — Launch",
    title: "Plank the Seed",
    desc: "Protected launch.",
    claims: ["ANTI-SNIPER ON", "ANTI-WHALE ON"],
  },
  {
    icon: "🪓",
    phase: "Phase 2 — Early",
    title: "You Can Plank Me Now",
    desc: "Controls removed.",
    claims: ["CONTRACT RENOUNCED", "CONTROLS OFF"],
  },
  {
    icon: "🔥",
    phase: "Phase 3 — Growth",
    title: "Wood You Rather",
    desc: "Add liquidity. Burn supply.",
    claims: ["LIQUIDITY ADDED", "SUPPLY BURNED"],
  },
  {
    icon: "🛸",
    phase: "Phase 4 — Uncharted",
    title: "Plank, in Space!",
    desc: "DEX and CEX expansion.",
    claims: ["DEX EXPANSION", "CEX PUSH"],
  },
];

export default function Roadmap() {
  return (
    <section id="roadmap" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">Roadmap</h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Four phases from seed to space.
          </p>
        </Reveal>

        <Reveal delayMs={80}>
          <div className="wood-frame relative mt-10 aspect-[1774/887] w-full overflow-hidden rounded-2xl">
            <Image
              src="/images/plank-plan.jpg"
              alt="RobinWood Plank roadmap banner showing four phases: Plank the Seed, You Can Plank Me Now, Wood You Rather, and Plank in Space"
              fill
              sizes="(min-width: 1280px) 1152px, 100vw"
              className="object-cover"
            />
          </div>
        </Reveal>

        <ol className="relative mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div
            aria-hidden="true"
            className="absolute left-0 right-0 top-8 hidden h-0.5 bg-gradient-to-r from-forest-600 via-gold-500 to-wood-600 lg:block"
          />
          {PHASES.map((p, i) => (
            <Reveal key={p.phase} delayMs={i * 120}>
              <li className="relative flex flex-col items-center rounded-2xl border border-gold-500/20 bg-wood-900/85 p-6 text-center">
                <div
                  className={`relative z-10 flex h-16 w-16 items-center justify-center rounded-full border-2 border-gold-500 bg-wood-950 text-3xl ${
                    i === 2 ? "animate-flicker" : ""
                  }`}
                  aria-hidden="true"
                >
                  {p.icon}
                </div>
                <span className="mt-4 text-xs font-bold uppercase tracking-widest text-gold-300">{p.phase}</span>
                <h3 className="mt-2 font-display text-2xl text-foreground">{p.title}</h3>
                <p className="mt-2 text-lg text-foreground">{p.desc}</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {p.claims.map((claim) => (
                    <span
                      key={claim}
                      className="rounded-full border border-forest-600 bg-forest-800/60 px-3 py-1 text-[0.65rem] font-extrabold uppercase tracking-wider text-gold-300"
                    >
                      {claim}
                    </span>
                  ))}
                </div>
              </li>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
