import Link from "next/link";
import { CHAIN, CONTRACT_ADDRESS, SOCIAL_LINKS } from "@/lib/constants";

const SOCIALS = [
  {
    name: "Twitter / X",
    href: SOCIAL_LINKS.twitter,
    icon: (
      <path d="M18.9 3H21l-6.6 7.55L22 21h-6.1l-4.8-6.3L5.6 21H3.4l7.1-8.1L2 3h6.2l4.3 5.7L18.9 3Zm-1.1 16.2h1.2L7.3 4.7H6l11.8 14.5Z" />
    ),
  },
];

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
          </section>

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
          </section>

          <nav aria-label="Footer">
            <h2 className="text-xs uppercase tracking-[0.16em] text-gold-300/80">
              Keep exploring
            </h2>
            <ul className="mt-2 grid grid-cols-2 gap-x-3 md:grid-cols-1">
              <li>
                <Link
                  href="/learn"
                  className="flex min-h-11 items-center text-sm text-foreground/75 transition-colors hover:text-gold-300"
                >
                  Learn how everything works
                </Link>
              </li>
              <li>
                <Link
                  href="/market"
                  className="flex min-h-11 items-center text-sm text-foreground/75 transition-colors hover:text-gold-300"
                >
                  Market
                </Link>
              </li>
              <li>
                <Link
                  href="/gallery"
                  className="flex min-h-11 items-center text-sm text-foreground/75 transition-colors hover:text-gold-300"
                >
                  Gallery
                </Link>
              </li>
              {SOCIALS.map((social) => (
                <li key={social.name}>
                  <a
                    href={social.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-11 items-center gap-2 text-sm text-foreground/75 transition-colors hover:text-gold-300"
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
          </nav>
        </div>

        <div className="mt-8 border-t border-gold-500/15 pt-5 text-xs text-foreground/45">
          © {new Date().getFullYear()} RobinWood. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
