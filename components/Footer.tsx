import { CONTRACT_ADDRESS, SOCIAL_LINKS } from "@/lib/constants";

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
    <footer className="wood-grain border-t border-gold-500/20 px-4 py-12 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 text-center">
        <p className="font-display text-xl text-gold-300">Built on Robinhood Chain. Built for $PLANK.</p>

        <p className="max-w-full break-all rounded-md bg-black/30 px-4 py-2 font-mono text-xs text-foreground/80 sm:text-sm">
          {CONTRACT_ADDRESS}
        </p>

        <ul className="flex items-center gap-4">
          {SOCIALS.map((s) => (
            <li key={s.name}>
              <a
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={s.name}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-gold-500/40 text-gold-300 transition-colors hover:border-gold-400 hover:bg-gold-500/10"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  {s.icon}
                </svg>
              </a>
            </li>
          ))}
        </ul>

        <p className="max-w-xl text-xs text-foreground/50">
          $PLANK is a meme coin with no intrinsic value or expectation of financial return. This is not
          financial advice. Nothing on this site is an offer to sell securities. Do your own research (DYOR)
          before participating.
        </p>

        <p className="text-xs text-foreground/40">© {new Date().getFullYear()} RobinWood. All rights reserved.</p>
      </div>
    </footer>
  );
}
