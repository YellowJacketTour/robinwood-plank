"use client";

/**
 * Guided vault migration: move planks out of the retiring vaults (V1, V2) into
 * the current vault. Detects the connected wallet's position across every
 * legacy vault, plans the moves with buildMigrationPlan(), and walks the
 * redeem -> deposit flow one plank at a time. Legacy vaults are the share-fee
 * model; the destination is the ETH-fee current vault.
 *
 * The plank-character-art rule (DESIGN.md): redeemed planks are shown as their
 * real NFT image, never a geometric stand-in. This first cut renders the plan,
 * states, and actions; the animated per-plank monitor is layered on next.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet-context";
import {
  getVaultByRole,
  listVaults,
  shortVault,
  vaultColorKind,
  vaultKindLabel,
  VAULT_LABEL_CLASS,
} from "@/lib/market/vault-registry";
import {
  getVaultOnChainSnapshot,
  getLpCredit,
  requestAndFinishRandomRedeem,
  depositForShares,
  sellShares,
  removeLiquidity,
  decodeVaultError,
} from "@/lib/market/vault";
import { getOwnedInventory } from "@/lib/market/inventory";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  buildMigrationPlan,
  formatShares,
  redeemCostShares,
  type MigrationPlan,
  type VaultPosition,
} from "@/lib/market/migration";
import { startVisibleInterval } from "@/lib/useVisibleInterval";

type OwnedPlank = { tokenId: string; image?: string; name?: string };

export default function MigrateView() {
  const { address, isConnected, connect } = useWallet();
  const primary = getVaultByRole("primary");
  const legacies = listVaults().filter((v) => v.role === "legacy");

  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [owned, setOwned] = useState<OwnedPlank[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  const scan = useCallback(async () => {
    if (!address) return;
    setScanning(true);
    try {
      const positions: VaultPosition[] = [];
      for (const v of legacies) {
        const [snap, lp] = await Promise.all([
          getVaultOnChainSnapshot(v.address, address),
          getLpCredit(address, v.address).catch(() => ({ shareCredit: BigInt(0), ethCredit: BigInt(0) })),
        ]);
        positions.push({
          address: v.address,
          generation: v.generation,
          version: v.version,
          walletShares: snap.shareBalance,
          lpShareCredit: lp.shareCredit,
          lpEthCredit: lp.ethCredit,
          redeemCostShares: redeemCostShares(snap.redeemFeeBps),
          poolShareReserve: snap.shareReserve,
          poolEthReserve: snap.ethReserve,
        });
      }
      setPlan(buildMigrationPlan(positions));

      const inv = await getOwnedInventory(MARKET_COLLECTIONS, address).catch(() => []);
      const planks: OwnedPlank[] = inv.flatMap((c: any) =>
        (c.items ?? []).map((it: any) => ({
          tokenId: String(it.tokenId),
          image: it.image,
          name: it.name,
        }))
      );
      setOwned(planks);
    } finally {
      setScanning(false);
    }
  }, [address]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!address) {
      setPlan(null);
      setOwned([]);
      return;
    }
    void scan();
    const stop = startVisibleInterval(() => {
      if (!runningRef.current) void scan();
    }, 20_000);
    return () => stop?.();
  }, [address, scan]);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setBusy(true);
      setError(null);
      setStatus(label);
      try {
        await fn();
        await scan();
      } catch (e) {
        setError(decodeVaultError(e));
      } finally {
        setBusy(false);
        setStatus(null);
        runningRef.current = false;
      }
    },
    [scan]
  );

  const withdrawLp = (vaultAddress: string, shareCredit: bigint, ethCredit: bigint) =>
    run("Withdrawing your liquidity…", async () => {
      await removeLiquidity(address!, shareCredit, ethCredit, undefined, vaultAddress);
    });

  const redeemOne = (vaultAddress: string) =>
    run("Redeeming a plank — waiting on the drand draw…", async () => {
      await requestAndFinishRandomRedeem(address!, vaultAddress, {
        onProgress: (m) => setStatus(m),
      });
    });

  const depositOwned = () =>
    run(`Depositing your planks into ${primary?.version ?? "the current vault"}…`, async () => {
      for (const p of owned) {
        // NOTE: the current vault is share-fee today; when it is the ETH-fee V3,
        // depositForShares must forward the mint fee as msg.value (wired with the
        // V3 call layer).
        await depositForShares(address!, p.tokenId, undefined, primary?.address ?? null);
      }
    });

  const sellDust = (vaultAddress: string, dust: bigint) =>
    run("Selling your dust for ETH…", async () => {
      await sellShares(address!, dust, 200, undefined, vaultAddress);
    });

  // ── Render ────────────────────────────────────────────────────────────────

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
      ) : scanning && !plan ? (
        <div className="rounded-xl border border-line bg-panel-strong p-5 text-sm text-cream/70">
          Scanning the retiring vaults for your position…
        </div>
      ) : plan && !plan.hasValue && owned.length === 0 ? (
        <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-5">
          <span className="rounded border border-emerald-400/50 bg-emerald-500/15 px-2 py-0.5 text-[0.6rem] font-black uppercase tracking-wide text-emerald-400">
            Nothing to migrate
          </span>
          <h2 className="mt-2 text-base font-extrabold text-cream">You&apos;re all set 🎉</h2>
          <p className="mt-1 text-sm text-cream/70">
            No value found in the retiring vaults for this wallet.
          </p>
          <Link
            href="/market?tab=swap"
            className="mt-3 inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 font-black text-[#261105]"
          >
            Open Instant Swap
          </Link>
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_316px]">
          <div className="space-y-4">
            {status && (
              <div className="rounded-lg border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-sm text-cream">
                {status}
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                {error}
              </div>
            )}

            {plan?.sources.map((s) => {
              const kind = vaultColorKind(s.address);
              return (
                <div key={s.address} className="rounded-xl border border-line bg-panel-strong p-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[0.6rem] font-black uppercase tracking-wide ${VAULT_LABEL_CLASS[kind]}`}
                    >
                      {vaultKindLabel(kind)}
                    </span>
                    <h3 className="text-sm font-extrabold text-cream">Your position on {s.version}</h3>
                    <span className="ml-auto font-mono text-[0.65rem] text-cream/45">
                      {shortVault(s.address)}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Stat k="Total shares" v={formatShares(s.totalShares, 2)} n="wallet + LP credit" />
                    <Stat k="Planks to move" v={String(s.redeemableNfts)} n="at the redeem cost" ok />
                    <Stat
                      k="Dust"
                      v={s.hasDust ? formatShares(s.dustShares, 2) : "None"}
                      n={s.hasDust ? "below one redeem" : "no leftover"}
                      ok={!s.hasDust}
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {s.needsLpWithdraw && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => withdrawLp(s.address, s.lpShareCredit, s.lpEthCredit)}
                        className="inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105] disabled:opacity-50"
                      >
                        Withdraw LP ({formatShares(s.lpShareCredit, 2)} sh
                        {s.lpEthCredit > BigInt(0) ? ` + ${formatShares(s.lpEthCredit, 4)} Ξ` : ""})
                      </button>
                    )}
                    {s.redeemableNfts > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => redeemOne(s.address)}
                        className="inline-flex min-h-[44px] items-center rounded-lg border border-line-strong bg-wood-950 px-4 text-sm font-bold text-cream disabled:opacity-50"
                      >
                        Redeem a plank
                      </button>
                    )}
                    {s.hasDust && !s.needsLpWithdraw && s.redeemableNfts === 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => sellDust(s.address, s.dustShares)}
                        className="inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105] disabled:opacity-50"
                      >
                        Sell dust for ETH · recommended
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {owned.length > 0 && (
              <div className="rounded-xl border border-line bg-panel-strong p-4">
                <h3 className="text-sm font-extrabold text-cream">
                  Planks in your wallet ({owned.length}) — ready to deposit
                </h3>
                <p className="mt-1 text-[0.7rem] text-cream/60">
                  Deposit these into {primary?.version ?? "the current vault"} to finish. Two signatures the
                  first time (approve, then deposit).
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => depositOwned()}
                  className="mt-3 inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105] disabled:opacity-50"
                >
                  Deposit {owned.length} plank{owned.length === 1 ? "" : "s"} into{" "}
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
    </section>
  );
}

function Stat({ k, v, n, ok }: { k: string; v: string; n: string; ok?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-wood-950 px-2.5 py-2">
      <div className="text-[0.55rem] font-black uppercase tracking-wide text-cream-muted">{k}</div>
      <div className={`font-mono text-lg ${ok ? "text-emerald-400" : "text-gold-300"}`}>{v}</div>
      <div className="text-[0.55rem] text-cream/50">{n}</div>
    </div>
  );
}
