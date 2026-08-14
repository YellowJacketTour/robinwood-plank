"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Share2, Users } from "lucide-react";
import { useWallet } from "@/lib/wallet-context";
import { buildWalletProof, REFERRAL_PROOF_DOMAIN } from "@/lib/wallet-proof-client";

type ReferralStatus = { enabled: boolean; configured: boolean };
type ReferralInfo = { referredBy: string | null; referredCount: number; code?: string | null };

const PENDING_REF_KEY = "plank_pending_referral";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** A ref is an opaque code, or a raw address from a pre-code link. Codes are
 * short enough to show whole; truncating one the way an address is truncated
 * mangles it into something that looks wrong and cannot be read back. */
function refLabel(ref: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(ref) ? shortAddr(ref) : ref.toUpperCase();
}

/**
 * Reads ?ref= if present and persists it to localStorage immediately, on
 * every mount, regardless of wallet connection state -- reading only
 * window.location.search at claim time (the original version of this
 * component) loses the code the moment a visitor browses to another page
 * before connecting, since the query param doesn't follow them. Once
 * captured, the stored value wins over a stale/absent URL param, and it's
 * cleared after a successful claim so it can't be replayed for a later,
 * unrelated wallet on the same browser.
 */
function capturePendingReferral(): void {
  if (typeof window === "undefined") return;
  const fromUrl = new URLSearchParams(window.location.search).get("ref");
  if (fromUrl) {
    try {
      window.localStorage.setItem(PENDING_REF_KEY, fromUrl);
    } catch {
      /* storage unavailable -- claim still works this same page load via the URL param */
    }
  }
}

function getPendingReferral(): string | null {
  if (typeof window === "undefined") return null;
  const fromUrl = new URLSearchParams(window.location.search).get("ref");
  if (fromUrl) return fromUrl;
  try {
    return window.localStorage.getItem(PENDING_REF_KEY);
  } catch {
    return null;
  }
}

function clearPendingReferral(): void {
  try {
    window.localStorage.removeItem(PENDING_REF_KEY);
  } catch {
    /* non-fatal -- worst case a future claim attempt just gets rejected as already-claimed */
  }
}

/**
 * Referral ATTRIBUTION only -- no rebate/payout amount is shown or implied
 * anywhere in this component. See lib/referral-server.ts's header for why
 * that's a deliberate scoping decision, not an oversight. This panel does
 * two things: (1) offers an explicit, signed confirmation when the visitor
 * arrived via ?ref=<code>, (2) shows the connected wallet's own shareable
 * invite link and how many wallets it has referred.
 *
 * The link carries an OPAQUE CODE, never the wallet address -- an invite gets
 * posted publicly by exactly the people with the most on-chain history to
 * expose, and ?ref=0x... published that address to everyone who saw it.
 *
 * Same self-hiding contract as MoonPayPanel/TradeModeSwitch's cross-chain
 * tab: renders nothing when the feature is off or unconfigured.
 */
export default function ReferralPanel() {
  const { address: account, connect: walletConnect } = useWallet();
  const [status, setStatus] = useState<ReferralStatus | null>(null);
  const [info, setInfo] = useState<ReferralInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const claimedRef = useRef(false);

  // Capture ?ref= into localStorage on every mount, unconditionally --
  // BEFORE the status fetch even resolves, so a visitor who lands on /trade
  // pre-connect and browses elsewhere first doesn't lose the code (see
  // capturePendingReferral's own header for why reading only the URL param
  // at claim time isn't enough).
  useEffect(() => {
    capturePendingReferral();
  }, []);

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

  // A pending referral is surfaced as an explicit action, NOT auto-claimed.
  //
  // The claim now requires a signature from the referred wallet (attribution
  // is permanent and has no repair path -- see lib/referral-server.ts). That
  // makes silent auto-claim the wrong shape twice over: it would fire an
  // unexplained personal_sign prompt the instant a wallet connects, and it
  // would ask someone to sign a permanent record without saying so. So the
  // panel asks, explains what the signature does, and only then claims.
  useEffect(() => {
    if (!status?.enabled || !status?.configured || !account) return;
    const ref = getPendingReferral();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingRef(ref && ref.toLowerCase() !== account.toLowerCase() ? ref : null);
  }, [status, account]);

  async function handleClaim() {
    if (!account || !pendingRef || claimedRef.current) return;
    claimedRef.current = true;
    setClaiming(true);
    setClaimError(null);
    try {
      const proof = await buildWalletProof(account, REFERRAL_PROOF_DOMAIN, "claim", {
        // Signs the ref EXACTLY as it came off the invite link. With opaque
        // codes the browser never learns the referrer's address, so the
        // signature covers what was on screen rather than something resolved
        // server-side afterwards.
        ref: pendingRef,
      });
      const resp = await fetch("/api/referral/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referredWallet: account, ref: pendingRef, proof }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || data.error || `status ${resp.status}`);
      clearPendingReferral();
      setPendingRef(null);
      setInfo((prev) => ({
        referredBy: data.referrerWallet ?? pendingRef,
        referredCount: prev?.referredCount ?? 0,
        // Keep the code: dropping it here blanked the user's own invite link
        // the moment they accepted someone else's.
        code: prev?.code ?? null,
      }));
    } catch (err) {
      // Rejecting the signature must be recoverable, not a dead end: the
      // code stays in localStorage and the button comes back.
      claimedRef.current = false;
      setClaimError(err instanceof Error ? err.message : "Could not record the invite.");
    } finally {
      setClaiming(false);
    }
  }

  // Reads this wallet's info, then mints its invite code if it has none yet.
  // The read no longer allocates (that made a public GET write for any wallet
  // in a query string), so the panel asks explicitly — once per wallet, for
  // the connected wallet only.
  useEffect(() => {
    if (!status?.enabled || !status?.configured || !account) return;
    let cancelled = false;
    fetch(`/api/referral/me?wallet=${account}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (d: ReferralInfo | null) => {
        if (cancelled) return d;
        if (d && !d.code) {
          try {
            const minted = await fetch("/api/referral/code", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ wallet: account }),
            }).then((r) => (r.ok ? r.json() : null));
            if (minted?.code) return { ...d, code: minted.code as string };
          } catch {
            /* link just stays pending -- the count and referredBy still render */
          }
        }
        return d;
      })
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

  // Shares the opaque code, never the wallet address. A referral link gets
  // posted to Telegram and X by exactly the people with the most on-chain
  // history to expose, and ?ref=0x... published that address to everyone who
  // saw it. Renders nothing until the code has loaded rather than falling
  // back to the address, which would quietly reintroduce the leak.
  const inviteUrl =
    info?.code && typeof window !== "undefined"
      ? `${window.location.origin}/trade?ref=${info.code}`
      : null;

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

  // Native share sheet where the platform supports it (most mobile
  // browsers) -- one tap straight to Messages/WhatsApp/etc. instead of
  // copy-then-switch-apps-then-paste. Progressive enhancement only: the
  // button doesn't render at all where navigator.share doesn't exist
  // (desktop Chrome/Firefox), Copy above always covers that case.
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  async function handleShare() {
    if (!inviteUrl) return;
    try {
      await navigator.share({ url: inviteUrl, title: "Trade $PLANK on RobinWood" });
    } catch {
      /* user cancelled the share sheet, or the platform rejected it -- Copy still works */
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
              {inviteUrl ?? "Preparing your invite link…"}
            </code>
            {canShare && (
              <button
                type="button"
                onClick={handleShare}
                disabled={!inviteUrl}
                className="flex min-h-9 shrink-0 items-center gap-1 rounded-md bg-panel px-2.5 text-[0.68rem] font-bold text-gold-300 transition-colors hover:bg-gold-500/10 disabled:opacity-50"
              >
                <Share2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                Share
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              disabled={!inviteUrl}
              aria-live="polite"
              className="flex min-h-9 shrink-0 items-center gap-1 rounded-md bg-gold-500 px-2.5 text-[0.68rem] font-bold text-on-gold transition-colors hover:bg-gold-400"
            >
              <Copy className="h-3 w-3 shrink-0" aria-hidden="true" />
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          {pendingRef && !info?.referredBy && (
            <div className="space-y-2 rounded-lg border border-gold-500/30 bg-gold-500/10 px-3 py-2.5">
              <p className="text-[0.72rem] leading-snug text-gold-300">
                You arrived from invite {refLabel(pendingRef)}. Confirming signs a message
                with your wallet to prove it&apos;s yours — free, no transaction, no gas. This is
                recorded <strong>permanently</strong> and can&apos;t be changed afterwards.
              </p>
              <button
                type="button"
                onClick={handleClaim}
                disabled={claiming}
                className="flex min-h-10 w-full items-center justify-center rounded-md bg-gold-500 px-3 text-xs font-bold uppercase tracking-wide text-on-gold transition-colors hover:bg-gold-400 disabled:opacity-60"
              >
                {claiming ? "Waiting for signature…" : "Confirm invite"}
              </button>
            </div>
          )}

          {claimError && (
            <p className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-[0.72rem] text-red-300">
              {claimError}
            </p>
          )}

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
