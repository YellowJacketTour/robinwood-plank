import Image from "next/image";
import Reveal from "@/components/Reveal";

const PHASES = [
  {
    icon: "🌱",
    phase: "Phase 1 — Launch",
    title: "Plank the Seed",
    desc: "LP early, 30m cooldowns, snipers get listed.",
    claims: ["DEATH TRAP", "BAD BOARDS", "30M COOLDOWN"],
    status: "done" as const,
  },
  {
    icon: "👀",
    phase: "Phase 2 — Look",
    title: "Wood You Just Look At It",
    desc: "Live Good Wood vs Bad Boards, lists exported before free trade.",
    claims: ["GOOD WOOD", "BAD BOARDS", "FALLEN"],
    status: "done" as const,
  },
  {
    icon: "🪓",
    phase: "Phase 3 — Early",
    title: "You Can Plank Me Now",
    desc: "Cooldowns done, LP renounced — free trading forever.",
    claims: ["LP RENOUNCED", "CONTROLS OFF", "FREE TRADE"],
    status: "current" as const,
  },
  {
    icon: "🔥",
    phase: "Phase 4 — Growth",
    title: "Wood You Rather",
    desc: "Add liquidity. Burn supply.",
    claims: ["LIQUIDITY ADDED", "SUPPLY BURNED"],
  },
  {
    icon: "🛸",
    phase: "Phase 5 — Uncharted",
    title: "Plank, in Space!",
    desc: "DEX and CEX expansion.",
    claims: ["DEX EXPANSION", "CEX PUSH"],
  },
];

export default function Roadmap() {
  return (
    <section id="roadmap" className="section-tight px-3 sm:px-5">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">Roadmap</h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Seed to space, five phases.
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

        <ol className="relative mt-10 grid grid-cols-1 gap-4 sm:mt-14 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-5">
          {PHASES.map((p, i) => (
            <Reveal key={p.phase} delayMs={i * 120}>
              <li className="relative flex flex-col items-center rounded-2xl border border-gold-500/20 bg-wood-900/85 p-5 text-center sm:p-6">
                <div className="relative">
                  <div
                    className={`relative z-10 flex h-14 w-14 items-center justify-center rounded-full border-2 bg-wood-950 text-2xl sm:h-16 sm:w-16 sm:text-3xl ${
                      p.status === "current"
                        ? "animate-flicker border-orange-500 ring-4 ring-orange-500/60 ring-offset-2 ring-offset-wood-900"
                        : "border-gold-500"
                    }`}
                    aria-hidden="true"
                  >
                    {p.icon}
                  </div>
                  {p.status === "done" && (
                    <span
                      className="absolute -right-1.5 -top-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-full border-2 border-wood-950 bg-emerald-500 text-sm font-black text-wood-950 shadow"
                      aria-label="Complete"
                      title="Complete"
                    >
                      ✓
                    </span>
                  )}
                </div>
                <span className="mt-4 text-xs font-bold uppercase tracking-widest text-gold-300">{p.phase}</span>
                <h3 className="mt-2 font-display text-xl text-foreground sm:text-2xl">{p.title}</h3>
                <p className="mt-2 text-sm text-foreground sm:text-lg">{p.desc}</p>
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
