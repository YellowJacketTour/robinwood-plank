import { CONTRACT_ADDRESS, SOCIAL_LINKS } from "@/lib/constants";

// TODO: replace href="#" values with real social URLs before launch.
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
      <path d="M21.5 3.5 2.7 10.9c-1.2.5-1.2 1.2-.2 1.5l4.8 1.5 1.8 5.6c.2.6.4.8.8.8.4 0 .6-.2.9-.5l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.6c.3-1.2-.4-1.7-1.2-1.2Z" />
    ),
  },
  {
    name: "Discord",
    href: SOCIAL_LINKS.discord,
    icon: (
      <path d="M20.3 5.3A17.4 17.4 0 0 0 15.9 4l-.4.8a15 15 0 0 1 3.9 1.4 15.8 15.8 0 0 0-13.8 0A15 15 0 0 1 9.5 4.8L9.1 4a17.4 17.4 0 0 0-4.4 1.3C2 9.9 1.2 14.4 1.6 18.8a17.6 17.6 0 0 0 5.3 2.7l.9-1.4a11 11 0 0 1-1.7-.8c.1-.1.3-.2.4-.3a12.6 12.6 0 0 0 10.9 0l.4.3c-.5.3-1.1.6-1.7.8l.9 1.4a17.5 17.5 0 0 0 5.3-2.7c.5-5.1-.8-9.5-2.9-13.5ZM8.7 14.9c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
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
