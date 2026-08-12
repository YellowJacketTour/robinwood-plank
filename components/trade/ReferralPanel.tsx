"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Users } from "lucide-react";
import { useWallet } from "@/lib/wallet-context";

type ReferralStatus = { enabled: boolean; configured: boolean };
type ReferralInfo = { referredBy: string | null; referredCount: number };

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Referral ATTRIBUTION only -- no rebate/payout amount is shown or implied
 * anywhere in this component. See lib/referral-server.ts's header for why
 * that's a deliberate scoping decision, not an oversight. This panel does
 * two things: (1) auto-claims a referral if the visitor arrived via
 * ?ref=0x... once their wallet connects, (2) shows the connected wallet's
 * own shareable invite link and how many wallets it has referred.
 *
 * Same self-hiding contract as MoonPayPanel/TradeModeSwitch's cross-chain
 * tab: renders nothing when the feature is off or unconfigured.
 */
export default function ReferralPanel() {
  const { address: account, connect: walletConnect } = useWallet();
  const [status, setStatus] = useState<ReferralStatus | null>(null);
  const [info, setInfo] = useState<ReferralInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const claimedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/referral/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ReferralStatus | null) => {
        if (!cancelled) setStatus(d);
      })
      .catch(() => {
        /* panel stays hidden -- rest of /trade still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-claim: only once per page load, only once a wallet is actually
  // connected, only when the URL actually carries ?ref=. Never re-claims on
  // every render, and the server independently rejects a self-referral or a
  // second, different referrer for a wallet that already has one on file
  // (lib/referral-server.ts's own immutability guarantee) -- this is a
  // convenience trigger, not the source of truth for correctness.
  useEffect(() => {
    if (!status?.enabled || !status?.configured || !account || claimedRef.current) return;
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (!ref || ref.toLowerCase() === account.toLowerCase()) return;
    claimedRef.current = true;
    fetch("/api/referral/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referredWallet: account, referrerWallet: ref }),
    }).catch(() => {
      /* best-effort -- the invite link still works next visit */
    });
  }, [status, account]);

  useEffect(() => {
    if (!status?.enabled || !status?.configured || !account) return;
    let cancelled = false;
    fetch(`/api/referral/me?wallet=${account}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ReferralInfo | null) => {
        if (!cancelled) setInfo(d);
      })
      .catch(() => {
        /* info just stays unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [status, account]);

  if (!status?.enabled || !status?.configured) return null;

  const inviteUrl = account && typeof window !== "undefined" ? `${window.location.origin}/trade?ref=${account}` : null;

  async function handleCopy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable -- fail silently, same as CopyCA */
    }
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-line bg-panel p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[0.7rem] font-black uppercase tracking-[0.08em] text-cream">
          <Users className="h-3.5 w-3.5 shrink-0 text-gold-400" aria-hidden="true" />
          Invite friends
        </p>
        {info && info.referredCount > 0 && (
          <span className="rounded-full border border-gold-500/35 bg-gold-500/10 px-2 py-0.5 text-[0.65rem] font-bold text-gold-300">
            {info.referredCount} referred
          </span>
        )}
      </div>

      {!account ? (
        <>
          <p className="text-[0.72rem] leading-snug text-cream-muted">
            Connect your wallet to get your own shareable invite link.
          </p>
          <button
            type="button"
            onClick={() => walletConnect()}
            className="flex min-h-11 w-full items-center justify-center rounded-md bg-gold-500 px-3 text-xs font-bold uppercase tracking-wide text-on-gold transition-colors hover:bg-gold-400"
          >
            Connect wallet
          </button>
        </>
      ) : (
        <>
          <p className="text-[0.72rem] leading-snug text-cream-muted">
            Share your link — anyone who visits and connects through it is credited as invited by you, permanently.
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-panel-strong px-2.5 py-2">
            <code className="min-w-0 flex-1 truncate text-[0.7rem] text-cream" title={inviteUrl ?? undefined}>
              {inviteUrl}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              aria-live="polite"
              className="flex min-h-9 shrink-0 items-center gap-1 rounded-md bg-gold-500 px-2.5 text-[0.68rem] font-bold text-on-gold transition-colors hover:bg-gold-400"
            >
              <Copy className="h-3 w-3 shrink-0" aria-hidden="true" />
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          {info?.referredBy && (
            <p className="text-[0.68rem] text-cream-muted">
              You were invited by {shortAddr(info.referredBy)}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
