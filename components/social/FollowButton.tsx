"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet-context";

type TargetType = "wallet" | "collection";

/**
 * Follow / unfollow toggle for a wallet or collection — wired to
 * app/api/social/follow/route.ts (lib/social-follows.ts, migration
 * 006_social_curation.sql). Renders nothing but a connect prompt when no
 * wallet is connected, matching the posture of every other wallet-gated
 * action in this app (see DESIGN.md: "Wallet gates explain what connection
 * unlocks before asking the user to connect.").
 */
export default function FollowButton({
  targetType,
  targetId,
  label,
}: {
  targetType: TargetType;
  targetId: string;
  label?: string;
}) {
  const { address, isConnected, openConnect } = useWallet();
  const [following, setFollowing] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isConnected || !address) return;
    let cancelled = false;
    fetch(`/api/social/follow?wallet=${encodeURIComponent(address)}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const list: string[] =
          targetType === "wallet" ? json.followed?.wallets ?? [] : json.followed?.collections ?? [];
        setFollowing(list.map((v) => v.toLowerCase()).includes(targetId.toLowerCase()));
      })
      .catch(() => {
        if (!cancelled) setFollowing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, isConnected, targetType, targetId]);

  async function toggle() {
    if (!isConnected || !address) {
      openConnect();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const action = following ? "unfollow" : "follow";
      const res = await fetch("/api/social/follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ followerWallet: address, targetType, targetId, action }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.message || "Follow request failed.");
      setFollowing(action === "follow");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Follow request failed.");
    } finally {
      setBusy(false);
    }
  }

  // Guarded by isConnected rather than resetting `following` on disconnect
  // in an effect (avoids a synchronous setState-in-effect cascade) — a
  // disconnected wallet never renders as "Following" regardless of what the
  // last-connected address's fetch returned.
  const isFollowing = isConnected && Boolean(following);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={isFollowing}
        className={`min-h-11 rounded-lg border px-4 text-sm font-bold transition disabled:opacity-60 ${
          isFollowing
            ? "border-line-strong bg-gold-500/15 text-gold-300 hover:bg-gold-500/25"
            : "border-line-strong bg-transparent text-cream hover:border-gold-400 hover:text-gold-300"
        }`}
      >
        {busy ? "…" : isFollowing ? "Following" : (label ?? "Follow")}
      </button>
      {error && (
        <p role="alert" className="text-xs font-bold text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
