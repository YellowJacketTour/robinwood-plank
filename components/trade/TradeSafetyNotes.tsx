import type { ComponentType } from "react";
import { BadgeCheck, Info, Link2Off, Lock, Waypoints } from "lucide-react";
import { CHAIN, CONTRACT_ADDRESS, SITE_FEE } from "@/lib/constants";
import { explorerTokenUrl } from "@/lib/trade";
import type { TradeMode, ZeroXStatusResponse } from "@/components/trade/TradeModeSwitch";

type Note = { title: string; body: string; icon: ComponentType<{ className?: string }> };

/**
 * "Not a bridge" was true when /trade only did same-chain swaps. It became
 * false the moment the "From another chain" mode shipped — that path
 * deliberately bridges via 0x (Across/Relay under the hood). Stating a
 * guarantee we no longer make, in the block literally labelled TRADING
 * SAFETY, is worse than saying nothing: people read this right before
 * deciding whether to sign. See docs/TRADE_PAGE_SPEC.md's cross-chain
 * safety-band item — every claim below is re-derived per mode instead of
 * asserting one static story for both.
 */
function buildNotes(isCrossChain: boolean, zeroXFeeLabel: string | null): Note[] {
  return [
    isCrossChain
      ? {
          title: "This mode bridges — on purpose",
          body: `"From another chain" is a real bridge: 0x's routers (via Across/Relay) move your funds from the source chain into ${CHAIN.name}. Settlement is not atomic — don't close the tab mid-flow. The destination is always the verified $PLANK contract below, never a wrapped stand-in.`,
          icon: Waypoints,
        }
      : {
          title: "Not a bridge",
          body: `Every swap routes to the official Uniswap Universal Router on ${CHAIN.name} — never Ethereum L1, never another chain.`,
          icon: Link2Off,
        },
    {
      title: "Verified contract only",
      body: isCrossChain
        ? "The widget and every deep-link here are hard-locked to the real $PLANK contract — even bridging in from another chain, delivery lands on this same verified contract. Always compare the address before signing."
        : "The widget and every deep-link here are hard-locked to the real $PLANK contract. Always compare the address before signing.",
      icon: BadgeCheck,
    },
    {
      title: "Fee is fixed, not negotiable",
      body: isCrossChain
        ? `The integrator fee is hard-coded server-side — ${zeroXFeeLabel ?? "a small, fixed rate"} on this path (0x's API only accepts whole basis points, so our exact ${SITE_FEE.label} rate is rounded down, never up). No client, wallet, or extension can change it.`
        : `The integrator fee is hard-coded server-side (${SITE_FEE.label}). No client, wallet, or extension can change it.`,
      icon: Lock,
    },
    {
      title: "Not financial advice",
      body: "Prices and quotes are informational. Confirm every amount in your wallet before signing.",
      icon: Info,
    },
  ];
}

type Props = {
  /** Which TradeModeSwitch tab is active, lifted via TradeActionZone. Every
   * claim below is re-checked against this — see buildNotes() above. */
  activeMode?: TradeMode;
  /** Same /api/zerox/status payload TradeModeSwitch already fetched, reused
   * so the cross-chain fee line shows the real rate (never re-fetched, never
   * guessed). */
  zeroXStatus?: ZeroXStatusResponse | null;
};

/**
 * Reads from the same constants (and, in cross-chain mode, the same live
 * status payload) the widgets themselves enforce, so this panel can never
 * drift from what the code actually does.
 *
 * Laid out as a full-width, four-up scannable strip (not a stacked rail
 * card) so every disclosure stays visible and legible without turning the
 * sidebar into a wall of paragraphs — same information, better hierarchy.
 */
export default function TradeSafetyNotes({ activeMode = "same", zeroXStatus }: Props = {}) {
  const isCrossChain = activeMode === "crosschain";
  const zeroXFeeLabel = zeroXStatus?.siteFee?.enabled ? zeroXStatus.siteFee.label : null;
  const NOTES = buildNotes(isCrossChain, zeroXFeeLabel);
  return (
    <section
      aria-label="Trading safety"
      className="wood-grain-surface space-y-3 rounded-xl border border-line bg-panel p-4 sm:p-5"
    >
      <p className="text-[0.7rem] font-black uppercase tracking-[0.08em] text-cream">
        Trading safety
      </p>
      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-1">
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
