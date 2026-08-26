import Link from "next/link";

export const dynamic = "force-static";

const featureCards = [
  {
    icon: "🎙️",
    title: "Live Audio Rooms",
    copy: "Drop into community conversations without leaving PlankSpace.",
  },
  {
    icon: "🪵",
    title: "Grab the Mic",
    copy: "Listeners can raise a hand, join the stage, and pass the floor.",
  },
  {
    icon: "🌲",
    title: "Built for the Grove",
    copy: "Wallet-aware rooms, familiar Plank profiles, and community moderation.",
  },
];

export default function WoodstockComingSoon() {
  return (
    <main className="relative min-h-[calc(100vh-116px)] overflow-hidden px-4 py-10 sm:px-6 sm:py-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(circle at 18% 12%, rgba(245,158,11,.16), transparent 28%), radial-gradient(circle at 82% 32%, rgba(120,53,15,.24), transparent 32%), linear-gradient(180deg, rgba(18,10,6,.1), rgba(18,10,6,.72))",
        }}
      />

      <section className="relative mx-auto max-w-5xl">
        <div className="overflow-hidden rounded-[28px] border border-amber-500/30 bg-[#1d110b]/90 shadow-[0_30px_90px_rgba(0,0,0,.45)] backdrop-blur">
          <div className="border-b border-amber-500/20 px-5 py-3 sm:px-8">
            <div className="flex items-center justify-between gap-4">
              <p className="m-0 text-xs font-black uppercase tracking-[0.22em] text-amber-300/80">
                PlankSpace Presents
              </p>
              <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[11px] font-black uppercase tracking-wider text-amber-200">
                In the workshop
              </span>
            </div>
          </div>

          <div className="grid gap-10 px-5 py-10 sm:px-8 sm:py-14 lg:grid-cols-[1.25fr_.75fr] lg:items-center lg:px-12">
            <div>
              <div className="mb-5 inline-flex items-center gap-3 rounded-full border border-amber-500/25 bg-black/20 px-4 py-2 text-sm font-bold text-amber-100/80">
                <span aria-hidden="true" className="text-lg">🔥</span>
                The campfire is being built
              </div>

              <h1 className="m-0 max-w-3xl text-5xl font-black leading-[.95] tracking-tight text-amber-100 sm:text-6xl lg:text-7xl">
                WOODSTOCK
              </h1>

              <p className="mt-4 max-w-2xl text-xl font-extrabold text-amber-300 sm:text-2xl">
                PlankSpace live conversations are coming.
              </p>

              <p className="mt-5 max-w-2xl text-base leading-7 text-amber-50/65 sm:text-lg">
                We are rebuilding Woodstock as a native PlankSpace experience instead of shipping a half-working room system.
                When it opens, the goal is simple: jump into the Grove, listen, grab the mic, and talk without leaving plank.love.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/plankspace"
                  className="inline-flex min-h-11 items-center rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-black uppercase tracking-wide text-[#24150d] no-underline transition hover:bg-amber-300"
                >
                  Back to Lumberyard
                </Link>
                <Link
                  href="/browse"
                  className="inline-flex min-h-11 items-center rounded-lg border border-amber-500/35 bg-black/20 px-5 py-2.5 text-sm font-black uppercase tracking-wide text-amber-100 no-underline transition hover:bg-amber-500/10"
                >
                  Browse Planks
                </Link>
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-sm">
              <div className="absolute -inset-8 rounded-full bg-amber-500/10 blur-3xl" />
              <div className="relative rounded-[26px] border border-amber-400/25 bg-gradient-to-b from-amber-950/80 to-black/45 p-7 shadow-2xl">
                <div className="mx-auto grid aspect-square max-w-[250px] place-items-center rounded-full border border-amber-400/25 bg-black/25 shadow-[inset_0_0_50px_rgba(245,158,11,.08)]">
                  <div className="text-center">
                    <div className="text-7xl" aria-hidden="true">🎙️</div>
                    <div className="mt-4 text-xs font-black uppercase tracking-[0.3em] text-amber-300/70">
                      Signal incoming
                    </div>
                  </div>
                </div>
                <div className="mt-6 flex items-center justify-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-amber-100/60">
                    Woodstock is offline for rebuilding
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-px border-t border-amber-500/20 bg-amber-500/15 sm:grid-cols-3">
            {featureCards.map((feature) => (
              <article key={feature.title} className="bg-[#1a0f09] p-6">
                <div className="text-2xl" aria-hidden="true">{feature.icon}</div>
                <h2 className="mt-3 text-sm font-black uppercase tracking-wide text-amber-200">
                  {feature.title}
                </h2>
                <p className="mt-2 text-sm leading-6 text-amber-50/55">
                  {feature.copy}
                </p>
              </article>
            ))}
          </div>
        </div>

        <p className="mx-auto mt-5 max-w-2xl text-center text-xs leading-5 text-amber-100/40">
          No separate wallet connection. No separate account. Woodstock will live inside the same PlankSpace and plank.love session.
        </p>
      </section>
    </main>
  );
}
