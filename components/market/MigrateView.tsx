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

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet-context";
import {
  getVaultByRole,
  shortVault,
  vaultColorKind,
  vaultKindLabel,
  vaultName,
  VAULT_LABEL_CLASS,
} from "@/lib/market/vault-registry";
import TokenPicker, { type PickerToken } from "@/components/market/TokenPicker";
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
import { getV3Snapshot, v3Deposit } from "@/lib/market/vault-v3";
import { useLegacyPosition, type SlotState } from "@/lib/market/useLegacyPosition";
import { formatShares, type SourcePlan } from "@/lib/market/migration";

/**
 * True when a deposit reverted because the plank is no longer the sender's to
 * deposit — i.e. it was already migrated (stale list). Benign: skip it rather
 * than aborting the batch. Anything else is a real failure worth surfacing.
 */
function isAlreadyMigratedError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes("incorrect owner") ||
    m.includes("not token owner") ||
    m.includes("not owned") ||
    m.includes("caller is not") ||
    m.includes("alreadyheld") ||
    m.includes("already held") ||
    m.includes("tokennotheld") ||
    m.includes("nonexistent token")
  );
}

export default function MigrateView() {
  const { address, isConnected, connect } = useWallet();
  const primary = getVaultByRole("primary");
  const pos = useLegacyPosition(isConnected ? address : null);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmForfeit, setConfirmForfeit] = useState<{ vault: string; requester: string } | null>(null);
  // Planks the user has selected to (optionally) deposit into V3 — never forced.
  const [selectedForDeposit, setSelectedForDeposit] = useState<Set<string>>(new Set());
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

  // OPTIONAL: deposit a user-chosen set of wallet planks into V3. Never forced,
  // never all-or-nothing — the caller passes exactly the ids the user picked.
  const depositPlanks = (ids: string[]) =>
    run(`Depositing ${ids.length} plank${ids.length === 1 ? "" : "s"} into ${primary?.name ?? "Premium Plank Liquidity"}…`, async () => {
      const isV3 = Boolean(primary && primary.feeModel === "eth");
      // V3 (ETH-fee) deposits must forward the mint fee via the V3 call layer —
      // the legacy depositForShares sends no value and reverts IncorrectFee.
      const snap = isV3 ? await getV3Snapshot(primary!.address, address!) : null;
      for (const id of ids) {
        try {
          if (isV3) await v3Deposit(address!, id, snap!, primary!.address);
          else await depositForShares(address!, id, undefined, primary?.address ?? null);
          pos.markDeposited(id); // optimistic: drops from the wallet list immediately
        } catch (e) {
          // A plank already deposited (stale list) is benign — skip it, don't
          // abort the whole batch or flash a scary revert. Re-throw anything else.
          if (isAlreadyMigratedError(e)) {
            pos.markDeposited(id);
            continue;
          }
          throw e;
        }
      }
      setSelectedForDeposit(new Set());
    });

  const sellDust = (vault: string, dust: bigint) =>
    run("Selling your dust for ETH…", () => sellShares(address!, dust, 200, undefined, vault));

  // ── Guided orchestration ──────────────────────────────────────────────────
  // The migration's ONLY goal is getting out of V1/V2 — once your value is
  // redeemed to your wallet you're done and safe. Depositing into V3 is a
  // separate, optional, plank-by-plank choice (below), never part of this path.
  const sources = pos.plan?.sources ?? [];
  const slotFreeFor = useCallback(
    (addr: string) => !(pos.slots[addr.toLowerCase()]?.busy ?? false),
    [pos.slots]
  );

  // A pending redeem I own — even on a vault that now has no other value (so it
  // isn't a "source"): still needs finishing. Look across ALL scanned slots.
  const mineSlot = useMemo(() => {
    const hit = Object.entries(pos.slots).find(([, s]) => s.mine);
    if (!hit) return null;
    const addr = hit[0];
    return { address: addr, name: vaultName(addr) };
  }, [pos.slots]);

  type NextAction =
    | { kind: "finishMine"; address: string; name: string }
    | { kind: "withdrawLp"; s: SourcePlan }
    | { kind: "redeem"; s: SourcePlan }
    | { kind: "dust"; s: SourcePlan }
    | null;

  // Ordered priority: finish a pending redeem I own → clear each source's LP →
  // redeem its planks → mop up dust. Sources are already V2→V1. NO deposit here.
  const nextAction: NextAction = useMemo(() => {
    if (mineSlot) return { kind: "finishMine", address: mineSlot.address, name: mineSlot.name };
    for (const s of sources) {
      if (s.needsLpWithdraw && s.lpWithdrawCovered) return { kind: "withdrawLp", s };
      if (s.redeemableNfts > 0 && slotFreeFor(s.address)) return { kind: "redeem", s };
    }
    for (const s of sources) if (s.hasDust) return { kind: "dust", s };
    return null;
  }, [mineSlot, sources, slotFreeFor]);

  // Value remains but nothing is doable right now: another wallet holds the
  // redeem slot, or LP can't be withdrawn until the pool has reserve. NOT done.
  const anyBlocked = useMemo(
    () =>
      sources.some((s) => {
        const slot = pos.slots[s.address.toLowerCase()];
        const othersSlotBusy = Boolean(slot?.busy && !slot?.mine);
        return (s.redeemableNfts > 0 && othersSlotBusy) || s.stuckLpShares > BigInt(0) || s.stuckLpEth > BigInt(0);
      }),
    [sources, pos.slots]
  );

  // Truly out of V1/V2: no legacy shares/LP/dust anywhere and no pending redeem.
  // Wallet planks (redeemed or pre-existing) do NOT keep this false — depositing
  // them into V3 is optional and separate.
  const outOfOldVaults = !nextAction && !anyBlocked;

  // Latch: did this wallet ever have legacy value this session? Lets us show the
  // "you're out of the old vaults 🎉" closure after the last redeem, without
  // showing the migration card at all to someone who only ever held V3 planks.
  const everHadLegacy = useRef(false);
  if (sources.length > 0 || mineSlot) everHadLegacy.current = true;
  const showMigrationCard = sources.length > 0 || mineSlot != null || anyBlocked || everHadLegacy.current;

  const nextLabel = (n: NextAction): string => {
    if (!n) return "All done";
    if (n.kind === "finishMine") return `Finish your pending ${n.name} redeem`;
    if (n.kind === "withdrawLp") return `Withdraw your ${vaultName(n.s.address)} liquidity`;
    if (n.kind === "redeem") return `Redeem a plank from ${vaultName(n.s.address)}`;
    return `Sell your ${vaultName(n.s.address)} dust for ETH`;
  };

  const doNext = useCallback(async () => {
    const n = nextAction;
    if (!n) return;
    if (n.kind === "finishMine") await finishMine(n.address);
    else if (n.kind === "withdrawLp") await withdrawLp(n.s.address, n.s.lpShareCredit, n.s.lpEthCredit);
    else if (n.kind === "redeem") await redeemOne(n.s.address);
    else if (n.kind === "dust") await sellDust(n.s.address, n.s.dustShares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextAction]);

  // Ordered remaining V1/V2-exit steps, for the stepper checklist (no deposit).
  const steps = useMemo(() => {
    const out: { key: string; label: string; sub: string }[] = [];
    if (mineSlot)
      out.push({ key: `fin-${mineSlot.address}`, label: `Finish your pending ${mineSlot.name} redeem`, sub: "the share is burned — claim the plank to free the slot" });
    for (const s of sources) {
      if (s.needsLpWithdraw)
        out.push({ key: `lp-${s.address}`, label: `Withdraw ${vaultName(s.address)} liquidity`, sub: `${formatShares(s.lpShareCredit, 2)} sh${s.lpEthCredit > BigInt(0) ? ` + ${formatShares(s.lpEthCredit, 4)} Ξ` : ""} back to shares` });
      for (let i = 0; i < s.redeemableNfts; i++)
        out.push({ key: `rd-${s.address}-${i}`, label: `Redeem a plank from ${vaultName(s.address)}`, sub: "drand draw · relayer finishes it for you" });
      if (s.stuckLpShares > BigInt(0) || s.stuckLpEth > BigInt(0))
        out.push({ key: `stuck-${s.address}`, label: `${vaultName(s.address)} liquidity is waiting`, sub: "the retiring pool can't cover the withdrawal yet — check back later" });
    }
    for (const s of sources) if (s.hasDust) out.push({ key: `dust-${s.address}`, label: `Sell ${vaultName(s.address)} dust`, sub: `${formatShares(s.dustShares, 2)} sh → ETH` });
    return out;
  }, [mineSlot, sources]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <section data-market-shell className="space-y-5">
      <header>
        <p className="text-[0.7rem] font-black uppercase tracking-[0.16em] text-cream-muted">
          Marketplank · Vault upgrade
        </p>
        <h1 className="mt-1 font-display text-3xl text-gold-300">Get out of the retiring vaults</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-cream/80">
          Driftwood and WormWood are winding down. This page walks you through redeeming your value out of them,
          one plank at a time, into your own wallet — that&apos;s the migration. Putting those planks into Premium
          Plank Liquidity afterwards is optional. You sign each step; we watch the chain in between.{" "}
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
      ) : pos.plan && !pos.hasValue ? (
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

            {/* Guided path — getting out of V1/V2 (deposit into V3 is separate) */}
            {showMigrationCard && (
            <div className="rounded-xl border border-line bg-panel-strong p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-display text-xl text-gold-300">
                  {nextAction ? "Your migration path" : anyBlocked ? "Almost there" : "You’re out of the old vaults"}
                </h2>
                {steps.length > 0 && (
                  <span className="text-[0.7rem] font-bold tabular-nums text-cream-muted">
                    {steps.length} step{steps.length === 1 ? "" : "s"} left
                  </span>
                )}
              </div>

              {steps.length > 0 && (
                <ol className="mt-3 space-y-1.5">
                  {steps.slice(0, 8).map((st, i) => (
                    <li
                      key={st.key}
                      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${
                        i === 0 ? "border-gold-500/50 bg-gold-500/10" : "border-line bg-wood-950"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-[0.6rem] font-black tabular-nums ${
                          i === 0 ? "bg-gold-500 text-[#261105]" : "border border-line-strong text-cream-muted"
                        }`}
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[0.8rem] font-bold text-cream">{st.label}</span>
                        <span className="block text-[0.66rem] text-cream/55">{st.sub}</span>
                        {i === 0 && status && (
                          <span className="mt-1 block text-[0.66rem] text-gold-300">
                            <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-gold-400 align-middle" />
                            {status}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                  {steps.length > 8 && (
                    <li className="px-3 text-[0.66rem] text-cream/50">+{steps.length - 8} more…</li>
                  )}
                </ol>
              )}

              {nextAction ? (
                <div className="mt-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void doNext()}
                    className="inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105] disabled:opacity-50"
                  >
                    {busy ? "Working…" : `Continue — ${nextLabel(nextAction)}`}
                  </button>
                </div>
              ) : anyBlocked ? (
                <div className="mt-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2.5 text-[0.78rem] text-amber-200">
                  Value is still here, but there&apos;s nothing to sign right now — another wallet holds a redeem
                  slot, or a retiring pool can&apos;t cover a liquidity withdrawal yet. It clears on its own; check
                  back, or use the per-vault controls below to settle a stuck slot.
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-sm text-emerald-300">
                    Your value is out of Driftwood &amp; WormWood and sitting safely in your wallet as planks. 🎉
                  </p>
                  <p className="mt-1 text-[0.72rem] text-cream/60">
                    That&apos;s the migration done. Putting planks into Premium Plank Liquidity is optional — do it below, or anytime on
                    the swap page.
                  </p>
                </div>
              )}
              {nextAction && (
                <p className="mt-2 text-[0.66rem] text-cream/50">
                  Migrating just means getting out of Driftwood &amp; WormWood — you sign each step, redeems finish automatically via
                  the relayer, and stopping anytime is safe (redeemed planks stay in your wallet).
                </p>
              )}
            </div>
            )}

            {/* OPTIONAL — deposit chosen wallet planks into V3. Never forced. */}
            {pos.owned.length > 0 && (
              <div className="rounded-xl border border-line bg-panel-strong p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-display text-lg text-gold-300">Optional: put planks into {primary?.name ?? "Premium Plank Liquidity"}</h2>
                  <span className="text-[0.66rem] text-cream-muted">{pos.owned.length} in your wallet</span>
                </div>
                <p className="mt-1 text-[0.72rem] text-cream/60">
                  Depositing mints one {primary?.name ?? "Premium Plank Liquidity"} share per plank (a flat ETH fee each). Pick the
                  ones you want — the rest stay in your wallet. You can also do this on the swap page.
                </p>
                <div className="mt-3">
                  <TokenPicker
                    tokens={pos.owned.map((p): PickerToken => ({ tokenId: p.tokenId, imageUrl: p.image }))}
                    selected={[...selectedForDeposit]}
                    onSelect={(id) =>
                      setSelectedForDeposit((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                    emptyMessage="No planks in your wallet."
                    allowManualEntry={false}
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || selectedForDeposit.size === 0}
                    onClick={() => void depositPlanks([...selectedForDeposit])}
                    className="inline-flex min-h-[44px] items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105] disabled:opacity-50"
                  >
                    {busy
                      ? "Working…"
                      : selectedForDeposit.size === 0
                        ? "Select planks to deposit"
                        : `Deposit ${selectedForDeposit.size} into ${primary?.name ?? "Premium Plank Liquidity"}`}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setSelectedForDeposit((prev) =>
                        prev.size === pos.owned.length ? new Set() : new Set(pos.owned.map((p) => p.tokenId))
                      )
                    }
                    className="inline-flex min-h-[44px] items-center rounded-lg border border-line-strong bg-wood-950 px-4 text-sm font-bold text-cream disabled:opacity-50"
                  >
                    {selectedForDeposit.size === pos.owned.length ? "Clear selection" : "Select all"}
                  </button>
                </div>
              </div>
            )}

            {/* Per-vault detail + manual controls / rescue, tucked away */}
            {pos.plan?.sources.length ? (
              <details className="overflow-hidden rounded-xl border border-line bg-panel-strong">
                <summary className="cursor-pointer list-none px-4 py-3 text-[0.72rem] font-bold text-cream-muted hover:text-cream">
                  Per-vault details &amp; manual controls
                </summary>
                <div className="space-y-4 border-t border-line p-4">
                  {pos.plan.sources.map((s) => (
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
                </div>
              </details>
            ) : null}
          </div>

          <aside className="space-y-3">
            <div className="rounded-xl border border-line bg-panel-strong p-4">
              <h3 className="text-sm font-extrabold text-cream">The honest math</h3>
              <ul className="mt-2 space-y-1.5 text-[0.72rem] text-cream/70">
                <li><b className="text-cream">Redeem</b> on the old vault burns <b className="text-cream">1 share</b> + a flat ETH fee and hands you the plank.</li>
                <li><b className="text-cream">Deposit</b> into {primary?.name ?? "Premium Plank Liquidity"} mints <b className="text-cream">exactly 1 share</b> for the same flat ETH fee.</li>
                <li>Round-trip cost is a little ETH in fees — <b className="text-cream">no migration tax</b>, no share haircut.</li>
                <li>The old pools&apos; seed ETH is non-withdrawable by design and stays behind — migrating doesn&apos;t recover it.</li>
              </ul>
            </div>
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
        <h3 className="text-sm font-extrabold text-cream">Your position on {vaultName(s.address)}</h3>
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
