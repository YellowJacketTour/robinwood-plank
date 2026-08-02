"use client";

import { Fuel, Sparkles } from "lucide-react";

/**
 * Phase B: lets the user opt into a UniswapX (gasless) quote instead of the
 * default CLASSIC route. Rendered only when the server has GASLESS_SWAPS_ENABLED
 * on (see lib/constants.ts) — the parent decides that, this component is
 * purely presentational + the on/off switch itself.
 *
 * Gasless swaps settle asynchronously (a filler broadcasts the fill, not the
 * user), so this toggle's copy is explicit about "no gas, but not instant" —
 * pairs with OrderStatus.tsx, which shows the pending/filled/expired states
 * once an order is actually submitted.
 */
export default function GaslessToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** True while a quote/order is in flight — avoid changing routing mid-swap. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left text-[0.7rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:text-xs ${
        checked
          ? "border-forest-500/50 bg-forest-900/40 text-forest-200"
          : "border-gold-500/20 bg-wood-950/40 text-foreground/60 hover:border-gold-500/35"
      }`}
    >
      <span className="flex items-center gap-1.5 font-bold uppercase tracking-wide">
        {checked ? <Sparkles size={13} className="shrink-0 text-forest-300" /> : <Fuel size={13} className="shrink-0" />}
        Gasless swap
      </span>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-forest-500" : "bg-wood-800"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-[2px]"
          }`}
        />
      </span>
    </button>
  );
}
