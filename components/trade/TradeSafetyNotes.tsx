import type { ComponentType } from "react";
import { BadgeCheck, Info, Link2Off, Lock } from "lucide-react";
import { CHAIN, CONTRACT_ADDRESS } from "@/lib/constants";
import { explorerTokenUrl } from "@/lib/trade";

const NOTES: { title: string; body: string; icon: ComponentType<{ className?: string }> }[] = [
  {
    title: "Not a bridge",
    body: `Every swap routes to the official Uniswap Universal Router on ${CHAIN.name} — never Ethereum L1, never another chain.`,
    icon: Link2Off,
  },
  {
    title: "Verified contract only",
    body: "The widget and every deep-link here are hard-locked to the real $PLANK contract. Always compare the address before signing.",
    icon: BadgeCheck,
  },
  {
    title: "Fee is fixed, not negotiable",
    body: "The integrator fee is hard-coded server-side. No client, wallet, or extension can change it.",
    icon: Lock,
  },
  {
    title: "Not financial advice",
    body: "Prices and quotes are informational. Confirm every amount in your wallet before signing.",
    icon: Info,
  },
];

/**
 * Static safety copy — reads directly from the same constants the widget
 * enforces so this panel can never drift from what the code actually does.
 *
 * Laid out as a full-width, four-up scannable strip (not a stacked rail
 * card) so every disclosure stays visible and legible without turning the
 * sidebar into a wall of paragraphs — same information, better hierarchy.
 */
export default function TradeSafetyNotes() {
  return (
    <section
      aria-label="Trading safety"
      className="wood-grain-surface space-y-3 rounded-xl border border-line bg-panel p-4 sm:p-5"
    >
      <p className="text-[0.7rem] font-black uppercase tracking-[0.08em] text-cream">
        Trading safety
      </p>
      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {NOTES.map(({ title, body, icon: Icon }) => (
          <li
            key={title}
            className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel-strong px-3 py-2.5"
          >
            <p className="flex items-center gap-1.5 text-xs font-bold text-gold-300">
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {title}
            </p>
            <p className="text-[0.7rem] leading-snug text-cream-muted">{body}</p>
          </li>
        ))}
      </ul>
      <a
        href={explorerTokenUrl()}
        target="_blank"
        rel="noopener noreferrer"
        className="block truncate text-center text-[0.65rem] text-cream-muted underline-offset-2 hover:text-gold-300 hover:underline"
        title={CONTRACT_ADDRESS}
      >
        View contract on {CHAIN.blockExplorers.default.name} ↗
      </a>
    </section>
  );
}
