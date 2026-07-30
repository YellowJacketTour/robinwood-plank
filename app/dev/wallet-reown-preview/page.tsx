"use client";

/**
 * Phase 1 verification harness for the Reown AppKit connect surface —
 * NOT a product page. Renders ConnectWalletModalSwitch in isolation so
 * both flag states can be screenshotted without touching any shared
 * consumer (MarketView.tsx / SwapWidget.tsx) that other concurrent work
 * currently owns. See lib/wallet-reown.ts and
 * docs/WALLET_REOWN_EVALUATION.md. Safe to delete once a later phase
 * wires the switch into a real call site and dogfoods it there instead.
 */

import { useEffect, useState } from "react";
import AppBackdrop from "@/components/AppBackdrop";
import ConnectWalletModalSwitch from "@/components/ConnectWalletModalSwitch";
import { isReownWalletUIEnabled, setReownWalletUIOverride } from "@/lib/wallet-reown";
import { CHAIN } from "@/lib/constants";

export default function WalletReownPreviewPage() {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  // null on first render (matches SSR, which has no localStorage) — set
  // for real in an effect after mount so this never causes a hydration
  // mismatch between server and client text.
  const [effectiveFlag, setEffectiveFlag] = useState<"legacy" | "reown" | null>(null);

  const refreshEffectiveFlag = () => setEffectiveFlag(isReownWalletUIEnabled() ? "reown" : "legacy");

  useEffect(() => {
    // Reads an external system (localStorage) post-mount, purely to avoid
    // an SSR/client text mismatch — not a derived-state anti-pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshEffectiveFlag();
  }, []);

  return (
    <>
      <AppBackdrop />
      <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-10 sm:px-5">
        <div
          data-market-shell
          className="mx-auto w-full max-w-xl space-y-4 rounded-xl border border-line bg-panel p-6 text-cream"
        >
          <p className="text-[0.6875rem] font-black uppercase tracking-[0.12em] text-cream-muted">
            Dev-only — wallet connect surface preview
          </p>
          <h1 className="font-display text-2xl text-gold-300">Reown AppKit — Phase 1</h1>
          <p className="min-h-5 text-sm text-cream-muted">
            {effectiveFlag ? (
              <>
                Effective: <strong className="text-gold-300">{effectiveFlag}</strong> · chain{" "}
                {CHAIN.id} ({CHAIN.name})
              </>
            ) : (
              " "
            )}
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setReownWalletUIOverride("legacy");
                refreshEffectiveFlag();
              }}
              className="min-h-10 rounded-lg border border-gold-500/30 px-3 text-xs font-bold text-gold-200 hover:border-gold-400"
            >
              Force legacy
            </button>
            <button
              type="button"
              onClick={() => {
                setReownWalletUIOverride("reown");
                refreshEffectiveFlag();
              }}
              className="min-h-10 rounded-lg border border-gold-500/30 px-3 text-xs font-bold text-gold-200 hover:border-gold-400"
            >
              Force reown
            </button>
            <button
              type="button"
              onClick={() => {
                setReownWalletUIOverride(null);
                refreshEffectiveFlag();
              }}
              className="min-h-10 rounded-lg border border-gold-500/30 px-3 text-xs font-bold text-gold-200 hover:border-gold-400"
            >
              Clear override (build default)
            </button>
          </div>

          <button
            type="button"
            onClick={() => setOpen(true)}
            className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 hover:bg-gold-400"
          >
            Connect wallet
          </button>

          <p className="min-h-6 text-sm text-cream-muted">
            {address ? `Connected: ${address}` : "Not connected."}
          </p>
        </div>
      </main>
      <ConnectWalletModalSwitch
        open={open}
        onClose={() => setOpen(false)}
        onConnected={(addr) => {
          setAddress(addr);
          setOpen(false);
        }}
      />
    </>
  );
}
