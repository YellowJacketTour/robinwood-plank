"use client";

/**
 * Dead-simple dual-vault migrate walkthrough for existing depositors.
 * Legacy vault stays redeemable until empty; primary is for new LP once V2 is live.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MARKET_VAULT_ADDRESS,
  MARKET_VAULT_DUAL_MODE,
  MARKET_VAULT_LEGACY_ADDRESS,
  MARKET_VAULT_V1_KNOWN,
} from "@/lib/constants";
import {
  dualVaultMode,
  listVaults,
  migrationFeeExplain,
  redeemCostShares,
  shortVault,
  VAULT_FEE_DEFAULTS,
} from "@/lib/market/vault-registry";
import {
  buyShares,
  decodeVaultError,
  depositForShares,
  finishRandomRedeem,
  getVaultOnChainSnapshot,
  redeemCostWei,
  requestAndFinishRandomRedeem,
  type VaultOnChainSnapshot,
} from "@/lib/market/vault";
import { formatTokenAmount, parseTokenAmount } from "@/lib/trade";
import { getOwnedInventory } from "@/lib/market/inventory";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { CHAIN } from "@/lib/constants";

type Props = {
  account: string | null;
  onConnect: () => void;
};

function explorerAddr(addr: string) {
  return `${CHAIN.blockExplorers.default.url}/address/${addr}`;
}

export default function VaultMigrate({ account, onConnect }: Props) {
  const vaults = listVaults();
  const dual = dualVaultMode();
  const legacyAddr =
    MARKET_VAULT_LEGACY_ADDRESS ||
    (MARKET_VAULT_ADDRESS?.toLowerCase() === MARKET_VAULT_V1_KNOWN.toLowerCase()
      ? MARKET_VAULT_ADDRESS
      : MARKET_VAULT_V1_KNOWN);
  const primaryAddr = MARKET_VAULT_ADDRESS;
  const v2Live =
    dual &&
    primaryAddr != null &&
    primaryAddr.toLowerCase() !== MARKET_VAULT_V1_KNOWN.toLowerCase() &&
    primaryAddr.toLowerCase() !== legacyAddr.toLowerCase();

  const [legacySnap, setLegacySnap] = useState<VaultOnChainSnapshot | null>(null);
  const [primarySnap, setPrimarySnap] = useState<VaultOnChainSnapshot | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dustEth, setDustEth] = useState("0.001");
  const [ownedAfter, setOwnedAfter] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const leg = await getVaultOnChainSnapshot(legacyAddr, account);
      setLegacySnap(leg);
      if (primaryAddr && primaryAddr.toLowerCase() !== legacyAddr.toLowerCase()) {
        setPrimarySnap(await getVaultOnChainSnapshot(primaryAddr, account));
      } else {
        setPrimarySnap(null);
      }
    } catch {
      /* keep last */
    }
  }, [account, legacyAddr, primaryAddr]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  const fees = useMemo(
    () =>
      legacySnap
        ? {
            mintFeeBps: legacySnap.mintFeeBps,
            redeemFeeBps: legacySnap.redeemFeeBps,
            targetPremiumBps: legacySnap.targetPremiumBps,
          }
        : VAULT_FEE_DEFAULTS,
    [legacySnap]
  );
  const feeExplain = useMemo(() => migrationFeeExplain(fees), [fees]);

  const randomCost = redeemCostWei(fees.redeemFeeBps, fees.targetPremiumBps, false);
  const balance = legacySnap?.shareBalance ?? BigInt(0);
  const shortfall = balance < randomCost ? randomCost - balance : BigInt(0);
  const canRedeem = balance >= randomCost && (legacySnap?.held ?? 0) > 0;

  const run = async (fn: () => Promise<string>, label: string, ok: string) => {
    setError(null);
    if (!account) {
      onConnect();
      return;
    }
    try {
      setBusy(true);
      setStatus(label);
      const hash = await fn();
      setStatus(`${ok} · ${hash.slice(0, 10)}…`);
      void refresh();
    } catch (e) {
      setError(decodeVaultError(e));
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(null), 8_000);
    }
  };

  const buyDust = () => {
    if (!canBuyDust()) return;
    return run(
      () => buyShares(account!, dustEth, 200, undefined, legacyAddr),
      "Buying dust shares on legacy vault…",
      "Dust bought — check share balance, then redeem."
    );
  };

  const canBuyDust = () => {
    const w = parseTokenAmount(dustEth, 18);
    return Boolean(account && w && w > BigInt(0) && legacySnap?.poolOpen);
  };

  const startRandomRedeem = () =>
    run(
      () =>
        requestAndFinishRandomRedeem(account!, legacyAddr, {
          onProgress: (msg) => setStatus(msg),
        }),
      "Random redeem on legacy (auto-claim)…",
      "NFT is in your wallet — next: deposit into the new vault."
    );

  const depositToPrimary = async (tokenId: string) => {
    if (!primaryAddr || !v2Live) {
      setError("New vault (V2) is not configured yet. Redeem still works on legacy; wait for V2 deploy.");
      return;
    }
    return run(
      () => depositForShares(account!, tokenId, undefined, primaryAddr),
      `Depositing #${tokenId} into new vault…`,
      "Deposited on V2 — you can Add / Remove LP there when open."
    );
  };

  const refreshOwned = async () => {
    if (!account) return;
    try {
      const inv = await getOwnedInventory(MARKET_COLLECTIONS, account);
      setOwnedAfter(inv.flatMap((i) => i.items).map((i) => i.tokenId));
    } catch {
      setOwnedAfter([]);
    }
  };

  useEffect(() => {
    if (account) void refreshOwned();
  }, [account, status]);

  return (
    <div className="wood-frame space-y-4 overflow-hidden rounded-2xl bg-wood-900/95 p-4 sm:p-5">
      <div>
        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.18em] text-gold-400/80">
          Dual vault · safe migrate
        </p>
        <h3 className="mt-1 font-display text-xl text-gold-300">Move deposits without getting stranded</h3>
        <p className="mt-2 text-sm leading-relaxed text-foreground/75">
          Your planks and vROBIN live on a specific vault contract. We never flip the site to a new vault
          without keeping the old one available for redeem. Migration is{" "}
          <strong className="text-foreground/90">optional</strong> — only if you want Add/Remove LP on the
          upgraded vault.
        </p>
      </div>

      {/* Status strip */}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-orange-500/35 bg-orange-500/5 px-3 py-2 text-xs">
          <p className="font-bold uppercase tracking-wide text-orange-400">
            <span className="rounded border border-orange-400/50 bg-orange-500/15 px-1.5 py-0.5 text-[0.65rem]">
              V1
            </span>{" "}
            Legacy (keep redeeming here)
          </p>
          <a
            href={explorerAddr(legacyAddr)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-gold-200 underline"
          >
            {shortVault(legacyAddr)}
          </a>
          {legacySnap && (
            <p className="mt-1 text-foreground/65">
              Holds {legacySnap.held} planks · your shares{" "}
              <span className="font-mono text-gold-200">
                {formatTokenAmount(legacySnap.shareBalance, 18, 4)}
              </span>
            </p>
          )}
        </div>
        <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/5 px-3 py-2 text-xs">
          <p className="font-bold uppercase tracking-wide text-emerald-400">
            <span className="rounded border border-emerald-400/50 bg-emerald-500/15 px-1.5 py-0.5 text-[0.65rem]">
              V2
            </span>{" "}
            {v2Live ? "New vault (deposit + LP here)" : "New vault (not live yet)"}
          </p>
          {v2Live && primaryAddr ? (
            <>
              <a
                href={explorerAddr(primaryAddr)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-gold-200 underline"
              >
                {shortVault(primaryAddr)}
              </a>
              {primarySnap && (
                <p className="mt-1 text-foreground/65">
                  Holds {primarySnap.held} planks · your shares{" "}
                  <span className="font-mono text-gold-200">
                    {formatTokenAmount(primarySnap.shareBalance, 18, 4)}
                  </span>
                  {primarySnap.supportsRemoveLp ? " · Remove LP ready" : ""}
                </p>
              )}
            </>
          ) : (
            <p className="mt-1 text-foreground/55">
              Operator deploys V2, sets{" "}
              <code className="font-mono text-[0.65rem]">NEXT_PUBLIC_MARKET_VAULT_ADDRESS</code> = new and{" "}
              <code className="font-mono text-[0.65rem]">NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS</code> ={" "}
              {shortVault(MARKET_VAULT_V1_KNOWN)}. Until then, use Instant Swap on the current vault.
            </p>
          )}
        </div>
      </div>

      {/* Fee honesty */}
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-3 text-sm text-amber-50/95">
        <p className="font-bold text-amber-100">Will you get ripped off redeeming?</p>
        <p className="mt-1.5 text-[0.85rem] leading-relaxed text-amber-50/85">
          <strong>No rug, no special migrate tax</strong> — same fees as always on this vault (mint{" "}
          {fees.mintFeeBps / 100}%, redeem {fees.redeemFeeBps / 100}%, +{fees.targetPremiumBps / 100}% if
          you pick a specific plank).
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.8rem] text-amber-50/80">
          <li>
            One deposit minted ~<strong>{feeExplain.sharesFromOneDeposit}</strong> shares (1% mint fee went
            to treasury).
          </li>
          <li>
            Random redeem burns ~<strong>{feeExplain.sharesForRandomRedeem}</strong> shares — so you need ~
            <strong>{feeExplain.dustSharesNeeded}</strong> extra if you only deposited once.
          </li>
          <li>
            Re-depositing into V2 mints ~{feeExplain.sharesFromOneDeposit} again (another mint fee). Round-trip
            share friction ≈ <strong>{feeExplain.roundTripShareFriction}</strong> shares per plank (~2% total
            fee on the share unit), plus gas.
          </li>
          <li>
            You get your <strong>NFT back</strong> on redeem (not vaporized). Treasury already took the fee
            at deposit; redeem fee is the designed exit cost for any user, not a migrate trap.
          </li>
          <li>
            Pool ETH / shares you never owned stay in the vault book — redeem does not steal others&apos;
            LP or seed.
          </li>
        </ul>
        <p className="mt-2 text-[0.75rem] text-amber-100/70">{feeExplain.summary}</p>
      </div>

      {/* Walkthrough */}
      <ol className="space-y-3">
        <Step n={1} title="Connect wallet on Robinhood Chain (4663)">
          {!account ? (
            <button
              type="button"
              onClick={onConnect}
              className="mt-1 min-h-9 rounded-lg bg-gold-500 px-3 text-xs font-bold text-wood-950"
            >
              Connect wallet
            </button>
          ) : (
            <p className="mt-1 font-mono text-xs text-gold-200/90">
              {account.slice(0, 6)}…{account.slice(-4)} · shares on legacy:{" "}
              {formatTokenAmount(balance, 18, 4)}
            </p>
          )}
        </Step>

        <Step n={2} title="If short on shares, buy dust (or deposit another plank)">
          <p className="mt-1 text-xs text-foreground/65">
            Need {formatTokenAmount(randomCost, 18, 4)} shares to random-redeem. You have{" "}
            {formatTokenAmount(balance, 18, 4)}.
            {shortfall > BigInt(0) ? (
              <>
                {" "}
                Short by <strong className="text-foreground/85">{formatTokenAmount(shortfall, 18, 4)}</strong>
                .
              </>
            ) : (
              <> You have enough for a random redeem.</>
            )}
          </p>
          {shortfall > BigInt(0) && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs text-foreground/55">
                ETH for dust buy
                <input
                  type="text"
                  inputMode="decimal"
                  value={dustEth}
                  onChange={(e) => setDustEth(e.target.value.replace(/[^0-9.]/g, ""))}
                  className="mt-0.5 block w-28 rounded border border-gold-500/30 bg-black/30 px-2 py-1 font-mono text-sm text-foreground"
                />
              </label>
              <button
                type="button"
                disabled={busy || !canBuyDust()}
                onClick={buyDust}
                className="min-h-9 rounded-lg bg-gold-500 px-3 text-xs font-bold text-wood-950 disabled:opacity-40"
              >
                Buy dust on legacy
              </button>
            </div>
          )}
        </Step>

        <Step n={3} title="Redeem on LEGACY vault (get NFT into your wallet)">
          <p className="mt-1 text-xs text-foreground/65">
            Random redeem auto-relays + claims after you confirm lock (frees the slot). Prefer random
            unless you need a specific plank (+{fees.targetPremiumBps / 100}% premium).
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !account || !canRedeem}
              onClick={startRandomRedeem}
              className="min-h-9 rounded-lg bg-gold-500 px-3 text-xs font-bold text-wood-950 disabled:opacity-40"
            >
              3 · Random redeem (auto-claim)
            </button>
            <button
              type="button"
              disabled={busy || !account}
              onClick={() =>
                run(
                  () =>
                    finishRandomRedeem(account!, legacyAddr, {
                      onProgress: (msg) => setStatus(msg),
                    }),
                  "Finishing redeem (relay + claim)…",
                  "NFT is in your wallet — next: deposit into the new vault."
                )
              }
              className="min-h-9 rounded-lg border border-gold-500/40 px-3 text-xs font-bold text-gold-200 disabled:opacity-40"
            >
              Retry claim if stuck
            </button>
            <button
              type="button"
              disabled={!account}
              onClick={() => void refreshOwned()}
              className="min-h-9 rounded-lg border border-gold-500/20 px-3 text-xs text-foreground/70"
            >
              Refresh my planks
            </button>
          </div>
          {!canRedeem && account && (
            <p className="mt-1 text-[0.7rem] text-amber-100/80">
              {balance < randomCost
                ? "Not enough shares yet — complete step 2."
                : "Legacy vault has no planks left to redeem."}
            </p>
          )}
        </Step>

        <Step n={4} title="Deposit into the NEW vault (only when V2 is live)">
          {!v2Live ? (
            <p className="mt-1 text-xs text-foreground/55">
              V2 not configured. After you redeem, your NFT is already safe in your wallet — you can hold,
              list on Marketplank, or wait and deposit when V2 goes live. Legacy Instant Swap still works
              until you leave.
            </p>
          ) : (
            <>
              <p className="mt-1 text-xs text-foreground/65">
                Pick a plank you own and deposit into{" "}
                <span className="font-mono text-gold-200">{shortVault(primaryAddr!)}</span>. You&apos;ll
                receive ~{feeExplain.sharesFromOneDeposit} V2 shares (mint fee again).
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ownedAfter.length === 0 ? (
                  <p className="text-[0.7rem] text-foreground/45">No planks detected in wallet — redeem first or refresh.</p>
                ) : (
                  ownedAfter.slice(0, 12).map((id) => (
                    <button
                      key={id}
                      type="button"
                      disabled={busy}
                      onClick={() => void depositToPrimary(id)}
                      className="rounded-md border border-gold-500/30 bg-black/30 px-2 py-1 font-mono text-[0.7rem] text-gold-200 hover:border-gold-400 disabled:opacity-40"
                    >
                      Deposit #{id}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </Step>

        <Step n={5} title="On V2: Add LP / Remove LP / Instant Swap">
          <p className="mt-1 text-xs text-foreground/65">
            Use Instant Swap with the <strong className="text-foreground/85">New vault</strong> selected.
            Add LP credits you for Remove LP on upgraded vaults. Leave leftover legacy shares only if you
            still want to redeem more from V1.
          </p>
        </Step>
      </ol>

      <div className="rounded-lg border border-gold-500/15 bg-black/20 px-3 py-2 text-[0.7rem] leading-relaxed text-foreground/55">
        <strong className="text-foreground/70">Do not:</strong> send NFTs or shares to a vault by raw
        transfer · switch wallet off chain 4663 · expect pool ETH to follow you (only your NFT + new shares
        after re-deposit).{" "}
        <a href="/learn#vault-migrate" className="text-gold-300 underline">
          Full migrate docs
        </a>
      </div>

      {error && (
        <p className="text-center text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
      {status && !error && (
        <p className="text-center text-xs text-emerald-200/90" role="status">
          {status}
        </p>
      )}

      {vaults.length > 0 && (
        <p className="text-center text-[0.65rem] text-foreground/40">
          Dual mode: {MARKET_VAULT_DUAL_MODE ? "on" : "off (single vault)"} · {vaults.map((v) => v.label).join(" · ")}
        </p>
      )}
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="rounded-xl border border-gold-500/20 bg-black/15 px-3 py-2.5">
      <p className="text-sm font-semibold text-foreground">
        <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-gold-500/90 text-xs font-black text-wood-950">
          {n}
        </span>
        {title}
      </p>
      {children}
    </li>
  );
}
