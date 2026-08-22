"use client";

import { useState } from "react";
import { grantPoints } from "../api";
import { BUTTON_PRIMARY, CARD, INPUT, LABEL, NOTE_ERR, NOTE_MUTED, NOTE_OK } from "../ui";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Manual marketplace-points grant -- the operator-facing half of the
 * points/social-rank system (lib/plank-checks.ts's "admin_grant" category,
 * app/api/admin/points/route.ts). Everything else in that ledger is
 * awarded automatically by trusted server code (the on-chain Seaport fill
 * indexer for real marketplace sales); this is the ONE deliberate manual
 * path, for the "lots of manual opportunities to reward by points
 * accumulated" the owner asked for -- a giveaway, a community moment, a
 * correction. Every grant requires a real reason, which becomes part of
 * the permanent audit trail (admin_log + the point event's own metadata),
 * since this is the one category with no independent on-chain
 * verification behind it.
 */
export default function PointsSection({ address }: { address: string | null }) {
  const [wallet, setWallet] = useState("");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const pointsNum = Number(points);
  const canGrant =
    !!address &&
    HEX_ADDRESS.test(wallet.trim()) &&
    Number.isFinite(pointsNum) &&
    pointsNum > 0 &&
    reason.trim().length > 0 &&
    !busy;

  const submit = async () => {
    if (!address || !canGrant) return;
    setBusy(true);
    setResult(null);
    const outcome = await grantPoints(wallet.trim(), Math.round(pointsNum), reason.trim(), address);
    setBusy(false);
    if (outcome.ok) {
      setResult({ ok: true, message: `Granted ${Math.round(pointsNum)} points to ${wallet.trim()}.` });
      setWallet("");
      setPoints("");
      setReason("");
    } else {
      setResult({ ok: false, message: outcome.message });
    }
  };

  return (
    <div className={CARD}>
      <h2 className="font-display text-lg text-gold-300">Marketplace points — manual grant</h2>
      <p className="mt-1 text-sm text-cream-muted">
        Every automatic point comes from a real on-chain marketplace fill (the Seaport fill indexer). This is the one
        manual path — a giveaway, a community reward, a correction. A reason is required and becomes part of the
        permanent record.
      </p>

      <div className="mt-4 space-y-3">
        <div>
          <label className={LABEL} htmlFor="points-wallet">
            Wallet address
          </label>
          <input
            id="points-wallet"
            className={`${INPUT} mt-1.5`}
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="0x..."
            disabled={busy}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="points-amount">
            Points
          </label>
          <input
            id="points-amount"
            className={`${INPUT} mt-1.5`}
            type="number"
            min={1}
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            placeholder="1000"
            disabled={busy}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="points-reason">
            Reason (required, permanent)
          </label>
          <input
            id="points-reason"
            className={`${INPUT} mt-1.5`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Discord AMA giveaway winner"
            maxLength={500}
            disabled={busy}
          />
        </div>
        <button type="button" className={BUTTON_PRIMARY} disabled={!canGrant} onClick={() => void submit()}>
          {busy ? "Signing…" : "Grant points"}
        </button>
      </div>

      {result && <p className={result.ok ? NOTE_OK : NOTE_ERR}>{result.message}</p>}
      {!address && <p className={NOTE_MUTED}>Connect an admin wallet to grant points.</p>}
    </div>
  );
}
