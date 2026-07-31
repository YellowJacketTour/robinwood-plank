"use client";

/**
 * Guided vault migration: move planks out of the retiring vaults (V1, V2) into
 * the current vault. Uses the shared useLegacyPosition scan for position + the
 * vault-wide redeem-slot state, plans the moves, and wires the redeem -> deposit
 * flow plus the built-in redeem-slot rescue. Legacy vaults are the share-fee
 * model; the destination is the ETH-fee current vault.
 *
 * Mockup predates V3, so it is structural reference only: the redeem/slot/drand
 * mechanics apply to the legacy SOURCE vaults (unchanged), while the destination
 * mints exactly one share for a flat ETH fee (no 0.99/1.01 deposit dust).
 * Redeemed planks are shown as their real NFT image (plank-character-art rule).
 */

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet-context";
import {
  getVaultByRole,
  shortVault,
  vaultColorKind,
  vaultKindLabel,
  VAULT_LABEL_CLASS,
} from "@/lib/market/vault-registry";
import {
  requestAndFinishRandomRedeem,
  finishRandomRedeem,
  claimRandomRedeemFor,
  forfeitExpiredRedeem,
  depositForShares,
  sellShares,
  removeLiquidity,
  decodeVaultError,
} from "@/lib/market/vault";
import { useLegacyPosition, type SlotState } from "@/lib/market/useLegacyPosition";
import { formatShares, type SourcePlan } from "@/lib/market/migration";

export default function MigrateView() {
  const { address, isConnected, connect } = useWallet();
  const primary = getVaultByRole("primary");
  const pos = useLegacyPosition(isConnected ? address : null);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmForfeit, setConfirmForfeit] = useState<{ vault: string; requester: string } | null>(null);
  const runningRef = useRef(false);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setBusy(true);
      setError(null);
      setStatus(label);
      try {
        await fn();
        await pos.refresh();
      } catch (e) {
        setError(decodeVaultError(e));
      } finally {
        setBusy(false);
        setStatus(null);
        runningRef.current = false;
      }
    },
    [pos]
  );

  const withdrawLp = (vault: string, sh: bigint, eth: bigint) =>
    run("Withdrawing your liquidity…", () => removeLiquidity(address!, sh, eth, undefined, vault));

  const redeemOne = (vault: string) =>
    run("Redeeming a plank — waiting on the drand draw…", () =>
      requestAndFinishRandomRedeem(address!, vault, { onProgress: setStatus })
    );

  const finishMine = (vault: string) =>
    run("Finishing your pending redeem…", () =>
      finishRandomRedeem(address!, vault, { onProgress: setStatus })
    );

  const settleTheirs = (vault: string, requester: string) =>
    run("Settling the pending redeem — frees the slot…", () =>
      claimRandomRedeemFor(address!, requester, undefined, vault)
    );

  const doForfeit = (vault: string, requester: string) =>
    run("Clearing the expired request…", () =>
      forfeitExpiredRedeem(address!, requester, undefined, vault)
    );

  const depositOwned = () =>
    run(`Depositing your planks into ${primary?.version ?? "the current vault"}…`, async () => {
      for (const p of pos.owned) {
        // NOTE: current vault is share-fee today; when it is the ETH-fee V3,
        // depositForShares must forward the mint fee (wired with the V3 call layer).
        await depositForShares(address!, p.tokenId, undefined, primary?.address ?? null);
      }
    });

  const sellDust = (vault: string, dust: bigint) =>
    run("Selling your dust for ETH…", () => sellShares(address!, dust, 200, undefined, vault));

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <section data-market-shell className="space-y-5">
      <header>
        <p className="text-[0.7rem] font-black uppercase tracking-[0.16em] text-cream-muted">
          Marketplank · Vault upgrade
        </p>
        <h1 className="mt-1 font-display text-3xl text-gold-300">Move your planks to the current vault</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-cream/80">
          The old vaults are retiring. This page moves your value one plank at a time — redeem on the old
          vault, deposit on the new. You sign when asked; we watch the chain in between.{" "}
          <b className="text-cream">Same fees as always — no migration tax.</b>
        </p>
      </header>

      {!isConnected ? (
        <div className="rounded-xl border border-line bg-panel-strong p-5">
          <h2 className="text-base font-extrabold text-cream">Connect to see if this concerns you</h2>
          <p className="mt-1 max-w-[64ch] text-sm text-cream/70">
            We check the retiring vaults for shares, dust, or a stuck redeem tied to your address. Nothing is
            signed by connecting.
          </p>
          <button
            type="button"
            onClick={() => void connect()}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 font-black text-[#261105]"
          >
            Connect wallet
          </button>
        </div>
      ) : pos.loading && !pos.plan ? (
        <div className="rounded-xl border border-line bg-panel-strong p-5 text-sm text-cream/70">
          Scanning the retiring vaults for your position…
        </div>
      ) : pos.plan && !pos.plan.hasValue && pos.owned.length === 0 ? (
        <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-5">
          <span className="rounded border border-emerald-400/50 bg-emerald-500/15 px-2 py-0.5 text-[0.6rem] font-black uppercase tracking-wide text-emerald-400">
            Nothing to migrate
          </span>
          <h2 className="mt-2 text-base font-extrabold text-cream">You&apos;re all set 🎉</h2>
          <p className="mt-1 text-sm text-cream/70">No value found in the retiring vaults for this wallet.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/market?tab=swap"
              className="inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 font-black text-[#261105]"
            >
              Open Instant Swap
            </Link>
            <Link
              href="/learn"
              className="inline-flex min-h-[44px] items-center rounded-lg border border-line-strong bg-wood-950 px-4 font-bold text-cream"
            >
              Learn about LP
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_316px]">
          <div className="space-y-4">
            {status && (
              <div className="rounded-lg border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-sm text-cream">
                <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-gold-400 align-middle" />
                {status}
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                {error}
              </div>
            )}

            {pos.plan?.sources.map((s) => (
              <SourceCard
                key={s.address}
                s={s}
                slot={pos.slots[s.address.toLowerCase()]}
                busy={busy}
                onWithdrawLp={() => withdrawLp(s.address, s.lpShareCredit, s.lpEthCredit)}
                onRedeem={() => redeemOne(s.address)}
                onSellDust={() => sellDust(s.address, s.dustShares)}
                onFinishMine={() => finishMine(s.address)}
                onSettleTheirs={(r) => settleTheirs(s.address, r)}
                onForfeit={(r) => setConfirmForfeit({ vault: s.address, requester: r })}
              />
            ))}

            {pos.owned.length > 0 && (
              <div className="rounded-xl border border-line bg-panel-strong p-4">
                <h3 className="text-sm font-extrabold text-cream">
                  Planks in your wallet ({pos.owned.length}) — ready to deposit
                </h3>
                <p className="mt-1 text-[0.7rem] text-cream/60">
                  Deposit these into {primary?.version ?? "the current vault"} to finish. Two signatures the
                  first time (approve, then deposit).
                </p>
                {pos.owned.some((p) => p.image) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {pos.owned.slice(0, 12).map((p) =>
                      p.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={p.tokenId}
                          src={p.image}
                          alt={p.name ?? `Plank #${p.tokenId}`}
                          className="h-14 w-14 rounded-md border border-line object-cover"
                        />
                      ) : null
                    )}
                  </div>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => depositOwned()}
                  className="mt-3 inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105] disabled:opacity-50"
                >
                  Deposit {pos.owned.length} plank{pos.owned.length === 1 ? "" : "s"} into{" "}
                  {primary?.version ?? "the current vault"}
                </button>
              </div>
            )}
          </div>

          <aside className="space-y-3">
            <div className="rounded-xl border border-line bg-panel-strong p-4">
              <h3 className="text-sm font-extrabold text-cream">What can never happen</h3>
              <ul className="mt-2 space-y-1.5 text-[0.72rem] text-cream/70">
                <li>
                  <b className="text-cream">Your planks can&apos;t be taken.</b> Redeem hands the NFT to your
                  wallet before anything else.
                </li>
                <li>
                  <b className="text-cream">No admin can touch pool ETH</b> — on any vault. That is why the old
                  seed ETH stays behind, by design.
                </li>
                <li>
                  <b className="text-cream">Stopping mid-way is safe.</b> A redeemed plank simply sits in your
                  wallet until you deposit it.
                </li>
              </ul>
            </div>
            <div className="rounded-xl border border-line bg-panel-strong p-4">
              <h3 className="text-sm font-extrabold text-cream">Need a human?</h3>
              <p className="mt-1 text-[0.72rem] text-cream/70">
                Every error here shows a plain-English fix. Full details live in{" "}
                <Link href="/learn" className="text-gold-300 underline">
                  Learn — Dual vault migrate
                </Link>
                .
              </p>
            </div>
          </aside>
        </div>
      )}

      {confirmForfeit && (
        <ConfirmForfeit
          onCancel={() => setConfirmForfeit(null)}
          onConfirm={() => {
            const { vault, requester } = confirmForfeit;
            setConfirmForfeit(null);
            void doForfeit(vault, requester);
          }}
        />
      )}
    </section>
  );
}

function SourceCard({
  s,
  slot,
  busy,
  onWithdrawLp,
  onRedeem,
  onSellDust,
  onFinishMine,
  onSettleTheirs,
  onForfeit,
}: {
  s: SourcePlan;
  slot?: SlotState;
  busy: boolean;
  onWithdrawLp: () => void;
  onRedeem: () => void;
  onSellDust: () => void;
  onFinishMine: () => void;
  onSettleTheirs: (requester: string) => void;
  onForfeit: (requester: string) => void;
}) {
  const kind = vaultColorKind(s.address);
  const slotBusy = slot?.busy ?? false;
  return (
    <div className="rounded-xl border border-line bg-panel-strong p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-[0.6rem] font-black uppercase tracking-wide ${VAULT_LABEL_CLASS[kind]}`}
        >
          {vaultKindLabel(kind)}
        </span>
        <h3 className="text-sm font-extrabold text-cream">Your position on {s.version}</h3>
        <span className="ml-auto font-mono text-[0.65rem] text-cream/45">{shortVault(s.address)}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat k="Total shares" v={formatShares(s.totalShares, 2)} n="wallet + LP credit" />
        <Stat k="Planks to move" v={String(s.redeemableNfts)} n="at the redeem cost" ok />
        <Stat
          k="Dust"
          v={s.hasDust ? formatShares(s.dustShares, 2) : "None"}
          n={s.hasDust ? "below one redeem" : "no leftover"}
          ok={!s.hasDust}
        />
        <Stat
          k="Redeem slot"
          v={slotBusy ? (slot?.mine ? "Yours" : "Busy") : "Free"}
          n={slotBusy ? "one at a time" : "no pending request"}
          ok={!slotBusy}
          warn={slotBusy}
        />
      </div>

      {/* Redeem-slot rescue — the slot is one-at-a-time vault-wide */}
      {slotBusy && (
        <div className="mt-3 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3">
          <p className="text-[0.72rem] font-bold text-amber-200">
            {slot?.mine
              ? "You have a pending redeem on this vault. Finish it before redeeming again."
              : "This vault's single redeem slot is occupied by another wallet. You can settle it for them (they get their plank, the slot frees — costs you only gas), or clear it if it has expired."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {slot?.mine ? (
              <button
                type="button"
                disabled={busy}
                onClick={onFinishMine}
                className="inline-flex min-h-[40px] items-center rounded-lg bg-gold-500 px-3.5 text-sm font-black text-[#261105] disabled:opacity-50"
              >
                Finish my redeem
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => onSettleTheirs(slot!.requester)}
                className="inline-flex min-h-[40px] items-center rounded-lg border border-line-strong bg-wood-950 px-3.5 text-sm font-bold text-cream disabled:opacity-50"
              >
                Settle theirs · frees the slot
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => onForfeit(slot!.requester)}
              className="inline-flex min-h-[40px] items-center rounded-lg border border-line px-3.5 text-sm font-bold text-cream/70 disabled:opacity-50"
            >
              Clear expired request
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {s.needsLpWithdraw && (
          <button
            type="button"
            disabled={busy}
            onClick={onWithdrawLp}
            className="inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105] disabled:opacity-50"
          >
            Withdraw LP ({formatShares(s.lpShareCredit, 2)} sh
            {s.lpEthCredit > BigInt(0) ? ` + ${formatShares(s.lpEthCredit, 4)} Ξ` : ""})
          </button>
        )}
        {s.redeemableNfts > 0 && !slotBusy && (
          <button
            type="button"
            disabled={busy}
            onClick={onRedeem}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-line-strong bg-wood-950 px-4 text-sm font-bold text-cream disabled:opacity-50"
          >
            Redeem a plank
          </button>
        )}
        {s.hasDust && !s.needsLpWithdraw && s.redeemableNfts === 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={onSellDust}
            className="inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105] disabled:opacity-50"
          >
            Sell dust for ETH · recommended
          </button>
        )}
      </div>
    </div>
  );
}

function ConfirmForfeit({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div data-market-shell className="w-full max-w-md rounded-xl border border-line-strong bg-panel-strong p-5">
        <h3 className="text-base font-extrabold text-cream">Clear this expired request?</h3>
        <p className="mt-2 text-sm text-cream/75">
          Forfeiting frees the vault-wide redeem slot. It only works if the request&apos;s drand round went
          unrelayed for ~24h. <b className="text-cream">The burned share goes to the treasury, not back to the
          requester</b> — this is what keeps the random draw binding, so only clear a genuinely stuck request.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-line px-4 text-sm font-bold text-cream"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105]"
          >
            Clear expired request
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, n, ok, warn }: { k: string; v: string; n: string; ok?: boolean; warn?: boolean }) {
  const tone = warn ? "text-amber-400" : ok ? "text-emerald-400" : "text-gold-300";
  return (
    <div className="rounded-lg border border-line bg-wood-950 px-2.5 py-2">
      <div className="text-[0.55rem] font-black uppercase tracking-wide text-cream-muted">{k}</div>
      <div className={`font-mono text-lg ${tone}`}>{v}</div>
      <div className="text-[0.55rem] text-cream/50">{n}</div>
    </div>
  );
}
