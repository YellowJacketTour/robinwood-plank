"use client";

import { useState } from "react";
import { CONTRACT_ADDRESS } from "@/lib/constants";

export default function CopyCA() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(CONTRACT_ADDRESS);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — fail silently.
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-stretch gap-2 rounded-xl border-2 border-gold-500/70 bg-wood-950/90 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center">
      {/* "CA" alone is ambiguous — this project has TWO contracts (the
          $PLANK ERC-20 and the RobinWood ERC-721). Naming the asset is the
          difference between a user verifying the right address and sending
          funds to the wrong one. */}
      <span className="shrink-0 rounded-md bg-gold-500/10 px-2 py-1 text-[0.68rem] font-bold uppercase tracking-widest text-gold-300">
        $PLANK token CA
      </span>
      <code className="min-w-0 flex-1 truncate text-left text-xs text-foreground/90 sm:text-sm" title={CONTRACT_ADDRESS}>
        {CONTRACT_ADDRESS}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded-md bg-gold-500 px-4 py-2 text-sm font-bold text-wood-950 transition-colors hover:bg-gold-400 active:scale-95"
        aria-live="polite"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}
