import Link from "next/link";
import {
  CHAIN,
  CONTRACT_ADDRESS,
  PLANKSPACE_URL,
  SOCIAL_LINKS,
} from "@/lib/constants";

const SOCIALS = [
  {
    name: "Twitter / X",
    href: SOCIAL_LINKS.twitter,
    icon: (
      <path d="M18.9 3H21l-6.6 7.55L22 21h-6.1l-4.8-6.3L5.6 21H3.4l7.1-8.1L2 3h6.2l4.3 5.7L18.9 3Zm-1.1 16.2h1.2L7.3 4.7H6l11.8 14.5Z" />
    ),
  },
  {
    name: "Telegram",
    href: SOCIAL_LINKS.telegram,
    icon: (
      <path d="m21.4 4.6-2.9 13.7c-.2 1-.8 1.2-1.6.7l-4.4-3.2-2.1 2c-.2.2-.4.4-.8.4l.3-4.5 8.2-7.4c.4-.4-.1-.6-.6-.2L7.4 12 3.1 10.6c-.9-.3-.9-.9.2-1.3L20 3c.8-.3 1.6.2 1.4 1.6Z" />
    ),
  },
];

/**
 * Every significant on-site destination, grouped for the "Keep exploring"
 * column. Kept as a flat list here (rather than sourced from NAV_LINKS)
 * because the footer reaches further than the top nav — it also carries
 * /floorboards, /migrate, /memes, and /launch, none of which are top-level
 * nav items.
 */
const EXPLORE_LINKS = [
  { href: "/market", label: "Market" },
  { href: "/trade", label: "Trade" },
  { href: "/mint", label: "Mint" },
  { href: "/launch", label: "Launch" },
  { href: "/gallery", label: "Gallery" },
  { href: "/memes", label: "Memes" },
  { href: PLANKSPACE_URL, label: "PlankSpace" },
  { href: "/learn", label: "Learn" },
  { href: "/floorboards", label: "Under the floorboards" },
  { href: "/migrate", label: "Migrate" },
] as const;

const LEGAL_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
] as const;

export default function Footer() {
  return (
    <footer className="site-footer-surface border-t border-gold-500/25 px-4 py-10 sm:px-6 lg:py-12">
      <div className="mx-auto max-w-[1200px]">
        <div className="grid gap-8 md:grid-cols-[1.15fr_1.5fr_0.85fr] md:gap-10">
          <section aria-labelledby="footer-about">
            <h2 id="footer-about" className="font-display text-xl text-gold-300">
              Built on Robinhood Chain.
              <span className="mt-1 block text-base text-foreground/70">Built for $PLANK.</span>
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-6 text-foreground/70">
              Meme coin. No promised return. Not financial advice. DYOR.
            </p>

            <ul className="mt-5 flex flex-wrap gap-3">
              {SOCIALS.map((social) => (
                <li key={social.name}>
                  <a
                    href={social.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-11 items-center gap-2 rounded-md border border-gold-500/20 bg-black/25 px-3 text-sm text-foreground/75 transition-colors hover:border-gold-400/60 hover:text-gold-300"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      {social.icon}
                    </svg>
                    {social.name}
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <nav aria-labelledby="footer-explore">
            <h2
              id="footer-explore"
              className="text-xs uppercase tracking-[0.16em] text-gold-300/80"
            >
              Keep exploring
            </h2>
            <ul className="mt-2 grid grid-cols-2 gap-x-3 sm:grid-cols-3">
              {EXPLORE_LINKS.map((link) => (
                <li key={link.href}>
                  {"external" in link && link.external ? (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${link.label} (opens in a new tab)`}
                      className="flex min-h-11 items-center text-sm text-foreground/75 transition-colors hover:text-gold-300"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      href={link.href}
                      className="flex min-h-11 items-center text-sm text-foreground/75 transition-colors hover:text-gold-300"
                    >
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          <section aria-labelledby="footer-contract">
            <h2
              id="footer-contract"
              className="text-xs uppercase tracking-[0.16em] text-gold-300/80"
            >
              $PLANK token contract
            </h2>
            <a
              href={`${CHAIN.blockExplorers.default.url}/address/${CONTRACT_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 block min-h-11 max-w-full break-all rounded-md border border-gold-500/20 bg-black/25 px-3 py-3 font-mono text-xs leading-5 text-foreground/80 transition-colors hover:border-gold-400/60 hover:text-gold-300 sm:text-sm"
              aria-label={`View $PLANK token contract ${CONTRACT_ADDRESS} on ${CHAIN.blockExplorers.default.name}`}
            >
              {CONTRACT_ADDRESS}
            </a>
            <p className="mt-2 text-xs text-foreground/45">{CHAIN.name}</p>
          </section>
        </div>

        <div className="mt-8 flex flex-col gap-3 border-t border-gold-500/15 pt-5 text-xs text-foreground/45 sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; {new Date().getFullYear()} RobinWood. All rights reserved.</p>
          <nav aria-label="Legal">
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="flex min-h-11 items-center text-foreground/60 transition-colors hover:text-gold-300 sm:min-h-0"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
