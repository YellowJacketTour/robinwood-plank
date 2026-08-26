/* eslint-disable @next/next/no-img-element */
import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Woodstock — PlankSpace",
  description:
    "PlankSpace live audio rooms are being rebuilt. Listen in, grab the mic, and talk without leaving plank.love.",
};

/**
 * Three authored 1.5-stroke icons in one weight, drawn for this page —
 * no emoji, no icon-font. Each is 24×24 on a 1.5 px stroke, rounded
 * joins, currentColor so they retint with the accent.
 */
function IconRooms() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2.5" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M5.5 5.5a9.3 9.3 0 0 0 0 13M18.5 5.5a9.3 9.3 0 0 1 0 13" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </svg>
  );
}

function IconGrove() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 7.5 10h2.2L6 15.5h4.5V21h3v-5.5H18L14.3 10h2.2Z" />
    </svg>
  );
}

const features = [
  {
    Icon: IconRooms,
    title: "Live audio rooms",
    copy: "Drop into community conversations without leaving PlankSpace.",
  },
  {
    Icon: IconMic,
    title: "Grab the mic",
    copy: "Listeners can raise a hand, join the stage, and pass the floor.",
  },
  {
    Icon: IconGrove,
    title: "Built for the Grove",
    copy: "Wallet-aware rooms, familiar Plank profiles, and community moderation.",
  },
];

export default function WoodstockComingSoon() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      data-woodstock
      className="relative min-h-[calc(100vh-116px)] px-3 py-8 sm:px-6 sm:py-14"
    >
      <section className="mx-auto w-full max-w-5xl min-w-0" aria-labelledby="woodstock-title">
        <div className="overflow-clip rounded-2xl border border-line-strong bg-panel-strong shadow-gold">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-8">
            <p className="m-0 text-xs font-bold tracking-wide text-cream-muted">Woodstock</p>
            <span className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-gold-500/10 px-3 py-1 text-xs font-bold text-gold-300">
              <span
                aria-hidden="true"
                className="h-2 w-2 animate-pulse rounded-full bg-gold-500 motion-reduce:animate-none"
              />
              In the workshop
            </span>
          </div>

          <div className="grid min-w-0 gap-8 px-4 py-9 sm:px-8 sm:py-12 lg:grid-cols-[1.25fr_.75fr] lg:items-center lg:px-12">
            <div className="min-w-0">
              <h1
                id="woodstock-title"
                className="m-0 font-display text-[clamp(2.25rem,11vw,4.5rem)] leading-[0.95] text-gold-300 [overflow-wrap:anywhere] [text-wrap:balance]"
              >
                Woodstock
              </h1>

              <p className="mt-4 max-w-2xl text-xl font-extrabold text-cream sm:text-2xl">
                PlankSpace live conversations are coming.
              </p>

              <p className="mt-4 max-w-2xl text-base leading-7 text-cream-muted sm:text-lg">
                We are rebuilding Woodstock as a native PlankSpace experience instead of
                shipping a half-working room system. When it opens, the goal is simple:
                jump into the Grove, listen, grab the mic, and talk without leaving
                plank.love.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/plankspace"
                  className="inline-flex min-h-11 items-center rounded-md bg-gold-500 px-5 font-bold text-wood-950 no-underline transition-colors hover:bg-gold-400"
                >
                  Back to the Lumberyard
                </Link>
                <Link
                  href="/browse"
                  className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-wood-900 px-5 font-bold text-cream no-underline transition-colors hover:bg-wood-800"
                >
                  Browse boards
                </Link>
              </div>
            </div>

            <div className="mx-auto w-full min-w-0 max-w-sm">
              <div className="relative rounded-xl border border-line bg-wood-900 p-6 shadow-panel">
                <div className="mx-auto flex max-w-[250px] flex-col items-center text-center">
                  <img
                    src="/images/plank-logo.webp"
                    alt=""
                    width={160}
                    height={160}
                    className="h-36 w-36 object-contain drop-shadow-[0_10px_18px_rgba(0,0,0,0.55)] sm:h-40 sm:w-40"
                  />
                  <p className="mt-3 text-sm font-bold text-gold-300">Signal incoming</p>
                  <p className="mt-1 text-sm text-cream-muted">
                    Woodstock is offline for rebuilding.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <ul className="m-0 grid list-none gap-px border-t border-line bg-line p-0 sm:grid-cols-3">
            {features.map(({ Icon, title, copy }) => (
              <li key={title} className="bg-panel-strong p-6">
                <span className="inline-grid h-10 w-10 place-items-center rounded-md border border-line bg-wood-900 text-gold-300 [&>svg]:h-5 [&>svg]:w-5">
                  <Icon />
                </span>
                <h2 className="mt-3 text-base font-extrabold text-cream">{title}</h2>
                <p className="mt-1 text-sm leading-6 text-cream-muted">{copy}</p>
              </li>
            ))}
          </ul>
        </div>

        <p className="mx-auto mt-5 max-w-2xl text-center text-sm leading-6 text-cream-muted">
          No separate wallet connection. No separate account. Woodstock will live inside
          the same PlankSpace and plank.love session.
        </p>
      </section>
    </main>
  );
}
