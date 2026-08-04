"use client";

import { useState } from "react";
import { useWallet } from "@/lib/wallet-context";
import {
  buildWalletProof,
  SOCIAL_ENDORSEMENTS_WALLET_PROOF_DOMAIN as WALLET_PROOF_DOMAIN,
} from "@/lib/wallet-proof-client";

type TargetType = "wallet" | "collection";

/**
 * "I back this" endorsement toggle — wired to app/api/social/endorse/route.ts
 * (lib/social-endorsements.ts, migration 008_social_endorsements.sql).
 * Unlike FollowButton, this requires a real wallet-signed proof (its own
 * domain, "social-endorsements" — see lib/social-endorsements.ts) because an
 * endorsement feeds a scored ranking (lib/social-rankings.ts) and must be
 * provably cast by the address it's attributed to, not merely self-asserted.
 */
export default function EndorseButton({
  targetType,
  targetId,
}: {
  targetType: TargetType;
  targetId: string;
}) {
  const { address, isConnected, openConnect } = useWallet();
  const [endorsed, setEndorsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    if (!isConnected || !address) {
      openConnect();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const voter = address.toLowerCase();
      const target = targetType === "wallet" ? targetId.trim().toLowerCase() : targetId.trim();
      const action = endorsed ? "unendorse" : "endorse";
      const proof = await buildWalletProof(voter, WALLET_PROOF_DOMAIN, action, {
        voter,
        targetType,
        targetId: target,
      });
      const res = await fetch("/api/social/endorse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voterWallet: voter, targetType, targetId: target, action, proof }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.message || "Endorsement request failed.");
      setEndorsed(action === "endorse");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Endorsement request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={endorsed}
        className={`min-h-11 rounded-lg border px-4 text-sm font-bold transition disabled:opacity-60 ${
          endorsed
            ? "border-line-strong bg-gold-500 text-wood-950 hover:bg-gold-400"
            : "border-line-strong bg-transparent text-cream hover:border-gold-400 hover:text-gold-300"
        }`}
      >
        {busy ? "…" : endorsed ? "Endorsed" : "Endorse"}
      </button>
      {error && (
        <p role="alert" className="text-xs font-bold text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
