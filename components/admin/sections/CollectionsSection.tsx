"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { MARKET_VAULT_ADDRESS } from "@/lib/constants";
import {
  EMPTY_VAULT_DEPLOY_INPUT,
  MAINNET_CONFIRMATION,
  validateVaultDeployInput,
  weiToEthDisplay,
  type VaultDeployInput,
  type VaultDeployNetwork,
  type VaultDeployProblem,
} from "@/lib/market/vault-deploy-v3";
import {
  sanitizeCollections,
  type CollectionsDoc,
  type StagedCollection,
} from "@/lib/content-docs";
import { useContentDocCard, CardChrome } from "./contentDocCard";
import { ExplorerAddress } from "../ExplorerAddress";
import { dispatchVaultDeploy, vaultDeployConfigured } from "../api";
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  CARD,
  INPUT,
  LABEL,
  NOTE_ERR,
  NOTE_MUTED,
  NOTE_OK,
} from "../ui";

/**
 * Collections section — see the explainer card at the top of the render:
 * the allowlist turns on Buy & Sell (Seaport marketplace) for a collection;
 * an Instant Swap vault is a separate optional contract per collection.
 * A collection can have both; trading always comes first.
 *
 * The LIVE list is a build-time constant (lib/market/collections.ts) because
 * it also feeds the wallet destination allowlist, which must fail closed at
 * startup. The STAGED list below it is the admin-edited database record a
 * release promotes into that constant.
 */

const EMPTY_DRAFT: StagedCollection = {
  slug: "",
  name: "",
  contractAddress: "",
  tokenStandard: "ERC721",
  feeBps: 50,
  vaultAddress: "",
  notes: "",
};

function Chip({
  tone,
  children,
}: {
  tone: "on" | "off" | "info";
  children: React.ReactNode;
}) {
  const cls =
    tone === "on"
      ? "border-emerald-400/40 text-emerald-400"
      : tone === "info"
        ? "border-gold-500/40 text-gold-300"
        : "border-line text-cream-muted";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.5625rem] font-black uppercase tracking-[0.12em] ${cls}`}
    >
      {children}
    </span>
  );
}

export default function CollectionsSection({
  address,
}: {
  address: string | null;
}) {
  return (
    <>
      {/* ------------------------------------------------- how it works -- */}
      <section className={CARD}>
        <h2 className="font-display text-xl text-gold-300">
          How collections work
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-line bg-panel-strong p-3">
            <p className={LABEL}>Layer 1 — Buy &amp; Sell</p>
            <p className="mt-2 text-sm text-cream">
              Being on the allowlist turns on the marketplace for a
              collection: listings, offers, sweeps — peer-to-peer trades
              settled through Seaport (already deployed &amp; audited). No new
              contract needed; each collection pays its own marketplace fee to
              the treasury.
            </p>
          </div>
          <div className="rounded-md border border-line bg-panel-strong p-3">
            <p className={LABEL}>Layer 2 — Instant Swap (vault, optional)</p>
            <p className="mt-2 text-sm text-cream">
              A separate MarketplankVault contract deployed per collection
              (ERC721 only): an always-on liquidity pool for share buys/sells
              and NFT deposit/redeem. Deployed with the vault deploy tool,
              seeded and opened by the treasury — added later, if ever.
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs text-cream-muted">
          A collection can have both — trading always comes first (RobinWood
          itself ran Buy &amp; Sell before its vault existed). Lifecycle:{" "}
          <strong className="text-cream">1 · Stage below</strong> →{" "}
          <strong className="text-cream">2 · Release promotes to live</strong>{" "}
          → <strong className="text-cream">3 · (optional) deploy + seed +
          open its vault</strong>.
        </p>
      </section>

      {/* ------------------------------------------------------- live ---- */}
      <section className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl text-gold-300">Live</h2>
          <p className={LABEL}>Trading now · baked into this release</p>
        </div>
        <ul className="mt-4 space-y-2">
          {MARKET_COLLECTIONS.map((c) => {
            // Today the site's vault wiring is the global env vault, which
            // belongs to RobinWood — currently the current-generation
            // Premium Plank Liquidity vault (resolved by address through
            // lib/market/vault-registry.ts, never assumed by generation
            // here); per-collection vaultAddress takes over once populated.
            const vault =
              c.vaultAddress ??
              (c.slug === "robinwood" ? MARKET_VAULT_ADDRESS : null);
            return (
              <li
                key={c.slug}
                className="rounded-md border border-line bg-panel-strong p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-cream">{c.name}</span>
                  <Chip tone="info">{c.tokenStandard}</Chip>
                  <Chip tone={c.feeBps > 0 ? "on" : "off"}>
                    fee {c.feeBps === 0 ? "0 (free)" : `${c.feeBps} bps`}
                  </Chip>
                  <Chip tone={vault ? "on" : "off"}>
                    {vault ? "Instant Swap live" : "trading only"}
                  </Chip>
                </div>
                <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                  <div>
                    <dt className={LABEL}>NFT contract</dt>
                    <dd className="mt-0.5 break-all text-cream-muted">
                      <ExplorerAddress address={c.contractAddress} />
                    </dd>
                  </div>
                  {vault ? (
                    <div>
                      <dt className={LABEL}>Vault contract</dt>
                      <dd className="mt-0.5 break-all text-cream-muted">
                        <ExplorerAddress address={vault} />
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-cream-muted">
          The live list is a code constant (lib/market/collections.ts) on
          purpose — it also feeds the wallet destination allowlist, which must
          fail closed at startup. Changes to it ship with a release.
        </p>
      </section>

      <StagedCollectionsCard address={address} />
      <VaultDeployCard address={address} />
    </>
  );
}

// --- vault deploy ------------------------------------------------------

type DeployState =
  | { kind: "idle" }
  | { kind: "invalid" }
  | { kind: "signing" }
  | { kind: "dispatching" }
  | { kind: "done"; runUrl: string | null; actionsUrl: string; network: VaultDeployNetwork }
  | { kind: "error"; message: string };

/**
 * A locally-remembered testnet rehearsal, keyed by collection address —
 * lets the mainnet step show "you already tried this collection" and offer
 * to carry its exact fee/seed values forward, instead of an admin re-typing
 * immutable wei amounts from memory (the single easiest way to make a costly
 * typo). This is a convenience cache in THIS browser's localStorage, not a
 * source of truth — it can't know about a rehearsal run from another machine,
 * and `deployedAddress` is filled in by the admin by hand (recording it from
 * the workflow's own output), not fetched automatically: doing that would
 * mean polling the run to completion and pulling the deploy-out/v3.json
 * artifact, real added surface deliberately left out of this pass.
 */
type VaultRehearsal = {
  input: VaultDeployInput;
  runUrl: string | null;
  actionsUrl: string;
  dispatchedAt: number;
  deployedAddress: string;
};

const REHEARSAL_STORAGE_KEY = "plank-admin-vault-rehearsals-v1";

function loadRehearsals(): Record<string, VaultRehearsal> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(REHEARSAL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, VaultRehearsal>) : {};
  } catch {
    return {};
  }
}

function saveRehearsal(collection: string, entry: VaultRehearsal): Record<string, VaultRehearsal> {
  const key = collection.trim().toLowerCase();
  const all = loadRehearsals();
  if (key) all[key] = entry;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(REHEARSAL_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Best-effort convenience cache — fine to silently lose (storage full/blocked).
    }
  }
  return all;
}

function timeAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** A wei input with its live ETH equivalent shown alongside — the whole point
 * is that these fields are wei, not the bps an admin might expect from the
 * old contract generation, and a typo here is unrecoverable after deploy. */
function WeiField({
  label,
  hint,
  value,
  onChange,
  problem,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  problem?: string;
}) {
  const eth = weiToEthDisplay(value);
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <input
        className={`${INPUT} mt-1 font-mono text-xs`}
        placeholder="wei, e.g. 1000000000000000"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        inputMode="numeric"
      />
      <p className="mt-1 text-[0.6875rem] text-cream-muted">
        {hint}
        {eth ? <> — <strong className="text-cream">{eth} ETH</strong></> : null}
      </p>
      {problem ? <p className="mt-1 text-xs text-rose-400">{problem}</p> : null}
    </label>
  );
}

/**
 * Deploys a new collection's Instant Swap vault by dispatching the gated
 * GitHub Actions workflow (.github/workflows/deploy-vault-v3.yml — the same
 * one that deployed RobinWood's own Premium Plank Liquidity pool; procedure:
 * docs/marketplank/DEPLOY-V3-RUNBOOK.md) instead of sending an admin to the
 * Actions tab. This form is a CALLER of that workflow, not a replacement for
 * its gates — the mainnet confirmation string, fee ceilings, and non-zero
 * mint/redeem check all still live in the workflow and the contract's
 * constructor; this only forwards validated inputs to it, and validates
 * client-side first so a bad value fails here instead of on-chain (real gas)
 * or mid-CI-run (wasted minutes).
 *
 * The deploy key (`secrets.DEPLOYER_PK`) is managed entirely on GitHub and
 * expected to rotate or be a dedicated wallet collaborators top up — this
 * form never assumes, displays, or validates against any particular deploy
 * address. `treasury` is typed here and reminded to match that key; it is
 * deliberately NOT auto-filled from the connected admin wallet, because the
 * wallet signing this dispatch and the key the workflow deploys with are
 * different keys by design.
 *
 * Testnet-first by design, mirroring docs/marketplank/DEPLOY-V3-RUNBOOK.md's
 * own sequence (the one that actually deployed RobinWood's V3 pool): testnet
 * is the default view (Step 1); mainnet is a deliberate "skip ahead" action
 * (Step 2), not a twin option in a neutral dropdown, and still requires the
 * typed DEPLOY_V3_MAINNET confirmation the workflow itself enforces. A
 * successful testnet dispatch is remembered per-collection in this browser
 * (see VaultRehearsal) so the mainnet step can show it and offer to copy its
 * exact fee/seed values forward — the highest-value thing this form can do,
 * since every one of those values is immutable and hand-retyping wei amounts
 * is exactly where a costly mistake happens. That memory is a convenience,
 * never a gate: there is no block on dispatching mainnet without one.
 *
 * (scripts/deploy-tool, the old locally-signed alternative, deployed the
 * prior share-fee contract and has been retired — see its README for why.)
 */
function VaultDeployCard({ address }: { address: string | null }) {
  const [staged, setStaged] = useState<StagedCollection[]>([]);
  useEffect(() => {
    // One-shot fetch of the staged list for the collection quick-pick;
    // failures just leave it showing live collections only.
    const controller = new AbortController();
    void fetch("/api/content/collections", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { doc?: unknown };
        const parsed = sanitizeCollections(data.doc);
        if (parsed.ok) setStaged(parsed.value.staged);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const pendingVaults = useMemo(
    () => staged.filter((c) => c.tokenStandard === "ERC721" && !c.vaultAddress),
    [staged]
  );

  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    void vaultDeployConfigured().then(setConfigured);
  }, []);

  // Hydrated post-mount (localStorage isn't available during SSR) — see
  // loadRehearsals/saveRehearsal above.
  const [rehearsals, setRehearsals] = useState<Record<string, VaultRehearsal>>({});
  useEffect(() => {
    // Hydrate from localStorage post-mount — same suppression as other
    // fetch/read-on-mount effects in this admin console (e.g. MusicSection).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRehearsals(loadRehearsals());
  }, []);

  const [input, setInput] = useState<VaultDeployInput>(EMPTY_VAULT_DEPLOY_INPUT);
  const set = useCallback(
    <K extends keyof VaultDeployInput>(key: K, value: VaultDeployInput[K]) =>
      setInput((prev) => ({ ...prev, [key]: value })),
    []
  );
  const [state, setState] = useState<DeployState>({ kind: "idle" });

  const problems = useMemo(() => validateVaultDeployInput(input), [input]);
  const problemFor = useCallback(
    (field: VaultDeployProblem["field"]) =>
      problems.find((p) => p.field === field)?.message,
    [problems]
  );

  const isMainnet = input.network === "robinhood";
  const busy = state.kind === "signing" || state.kind === "dispatching";

  const rehearsal = rehearsals[input.collection.trim().toLowerCase()];

  const applyRehearsal = useCallback(() => {
    if (!rehearsal) return;
    // Deliberately NOT copied: treasury, confirmation, network — those must
    // be typed fresh for mainnet, never carried over from a testnet run
    // where treasury commonly just defaults to the signer.
    setInput((prev) => ({
      ...prev,
      // name/symbol ARE copied — unlike treasury/confirmation, these should
      // be identical between the rehearsal and the real deploy.
      shareName: rehearsal.input.shareName,
      shareSymbol: rehearsal.input.shareSymbol,
      mintFeeWei: rehearsal.input.mintFeeWei,
      redeemFeeWei: rehearsal.input.redeemFeeWei,
      targetPremiumWei: rehearsal.input.targetPremiumWei,
      swapFeeBps: rehearsal.input.swapFeeBps,
      seedTokenIds: rehearsal.input.seedTokenIds,
      seedEthWei: rehearsal.input.seedEthWei,
      confirmOpen: rehearsal.input.confirmOpen,
    }));
  }, [rehearsal]);

  const recordDeployedAddress = useCallback(
    (addr: string) => {
      if (!rehearsal) return;
      setRehearsals(saveRehearsal(input.collection, { ...rehearsal, deployedAddress: addr }));
    },
    [rehearsal, input.collection]
  );

  const submit = useCallback(async () => {
    if (!address) return;
    if (problems.length > 0) {
      setState({ kind: "invalid" });
      return;
    }
    setState({ kind: "signing" });
    const outcome = await dispatchVaultDeploy(input, address);
    if (!outcome.ok) {
      setState({ kind: "error", message: outcome.message });
      return;
    }
    if (input.network === "robinhood-testnet") {
      setRehearsals(
        saveRehearsal(input.collection, {
          input,
          runUrl: outcome.runUrl,
          actionsUrl: outcome.actionsUrl,
          dispatchedAt: Date.now(),
          deployedAddress: rehearsal?.deployedAddress ?? "",
        })
      );
    }
    setState({
      kind: "done",
      runUrl: outcome.runUrl,
      actionsUrl: outcome.actionsUrl,
      network: input.network,
    });
  }, [address, input, problems.length, rehearsal]);

  return (
    <section className={CARD}>
      <h2 className="font-display text-xl text-gold-300">Deploy a vault</h2>
      <p className={`mt-1 ${LABEL}`}>
        Dispatches the gated GitHub Actions workflow — your wallet signs the
        request, never the deploy key
      </p>
      <p className="mt-3 text-sm text-cream">
        Every new collection vault deploys on the current-generation contract
        (Premium Plank Liquidity&apos;s design) via{" "}
        <code className="font-mono text-xs">
          .github/workflows/deploy-vault-v3.yml
        </code>
        . Full procedure:{" "}
        <code className="font-mono text-xs">docs/marketplank/DEPLOY-V3-RUNBOOK.md</code>.
        The deploy key (<code className="font-mono text-xs">DEPLOYER_PK</code>)
        lives in GitHub as a repo secret and is managed there — an admin who
        can change secrets can rotate it or point at a dedicated wallet
        independent of this form.
      </p>

      {configured === false ? (
        <div className={NOTE_MUTED}>
          <p>
            This form can&apos;t dispatch anything until an admin sets these
            on the server (never sent to the browser — the GET check only
            ever returns a boolean):
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            <li>
              <code className="font-mono text-xs">GITHUB_DISPATCH_TOKEN</code> —
              a fine-grained token scoped to{" "}
              <code className="font-mono text-xs">actions: write</code> on this
              repo only, nothing broader
            </li>
            <li>
              <code className="font-mono text-xs">GITHUB_DISPATCH_REPO</code> —
              defaults to this repo if unset
            </li>
            <li>
              <code className="font-mono text-xs">GITHUB_DISPATCH_REF</code> —
              defaults to <code className="font-mono text-xs">master</code> if unset
            </li>
          </ul>
          <p className="mt-1.5">
            To install it, store the token as the repository secret{" "}
            <code className="font-mono text-xs">VAULT_DISPATCH_TOKEN</code> —
            GitHub rejects any secret whose name begins with{" "}
            <code className="font-mono text-xs">GITHUB_</code>, so it cannot be
            stored under the name the server reads — then run the InMotion
            Passenger CI/CD workflow with{" "}
            <code className="font-mono text-xs">operation=set-dispatch-token</code>.
          </p>
          <p className="mt-1.5">
            Or dispatch the workflow directly from the Actions tab in the
            meantime.
          </p>
        </div>
      ) : null}

      <div className="mt-4 rounded-md border border-line bg-panel-soft p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className={LABEL}>
            {isMainnet ? "Step 2 — Mainnet deploy" : "Step 1 — Testnet rehearsal"}
          </h3>
          {isMainnet ? (
            <button
              type="button"
              className={`${BUTTON_SECONDARY} h-8 px-3 text-[0.5625rem]`}
              onClick={() => {
                set("network", "robinhood-testnet");
                set("confirmation", "");
              }}
            >
              ← Back to testnet rehearsal
            </button>
          ) : (
            <button
              type="button"
              className={`${BUTTON_SECONDARY} h-8 px-3 text-[0.5625rem]`}
              onClick={() => set("network", "robinhood")}
            >
              Skip ahead: deploy to mainnet instead →
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-cream-muted">
          {isMainnet
            ? "Real value, immutable on success — rehearse these exact inputs on testnet first if you have not already."
            : "The recommended default: exercises the same deploy + seed (+ open) flow against Robinhood's testnet before anything real is at stake."}
        </p>

        {isMainnet ? (
          <div className="mt-3 rounded-md border border-rose-400/40 bg-rose-400/10 p-3">
            <p className="text-xs text-rose-400">
              This deploys a contract that will custody real value. Every
              field below is immutable the moment it lands on-chain.
            </p>
            <label className="mt-2 block">
              <span className={LABEL}>
                Type <code className="font-mono">{MAINNET_CONFIRMATION}</code>{" "}
                to allow this dispatch
              </span>
              <input
                className={`${INPUT} mt-1 font-mono text-xs`}
                value={input.confirmation}
                onChange={(e) => set("confirmation", e.target.value)}
                spellCheck={false}
              />
              {problemFor("confirmation") ? (
                <p className="mt-1 text-xs text-rose-400">{problemFor("confirmation")}</p>
              ) : null}
            </label>

            {rehearsal ? (
              <div className="mt-3 rounded-md border border-line bg-panel-strong p-3">
                <p className={LABEL}>Last testnet deploy for this collection</p>
                <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-cream-muted">Dispatched</dt>
                    <dd className="text-cream">{timeAgo(rehearsal.dispatchedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-cream-muted">Run</dt>
                    <dd className="text-cream">
                      <a
                        href={rehearsal.runUrl ?? rehearsal.actionsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        {rehearsal.runUrl ? "view run" : "Actions tab"}
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-cream-muted">share name / symbol</dt>
                    <dd className="font-mono text-cream">
                      {rehearsal.input.shareName} ({rehearsal.input.shareSymbol})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-cream-muted">mintFeeWei</dt>
                    <dd className="font-mono text-cream">{rehearsal.input.mintFeeWei}</dd>
                  </div>
                  <div>
                    <dt className="text-cream-muted">redeemFeeWei</dt>
                    <dd className="font-mono text-cream">{rehearsal.input.redeemFeeWei}</dd>
                  </div>
                  <div>
                    <dt className="text-cream-muted">targetPremiumWei</dt>
                    <dd className="font-mono text-cream">{rehearsal.input.targetPremiumWei}</dd>
                  </div>
                  <div>
                    <dt className="text-cream-muted">swapFeeBps</dt>
                    <dd className="font-mono text-cream">{rehearsal.input.swapFeeBps}</dd>
                  </div>
                  <div>
                    <dt className="text-cream-muted">seed token ids</dt>
                    <dd className="font-mono text-cream">{rehearsal.input.seedTokenIds || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-cream-muted">seed ETH (wei)</dt>
                    <dd className="font-mono text-cream">{rehearsal.input.seedEthWei || "—"}</dd>
                  </div>
                </dl>
                <label className="mt-2 block">
                  <span className={LABEL}>
                    Deployed testnet vault address (recorded by you, once known)
                  </span>
                  <input
                    className={`${INPUT} mt-1 font-mono text-xs`}
                    placeholder="0x… paste once you have it from the run output"
                    value={rehearsal.deployedAddress}
                    onChange={(e) => recordDeployedAddress(e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  className={`${BUTTON_SECONDARY} mt-2 h-8 px-3 text-[0.5625rem]`}
                  onClick={applyRehearsal}
                >
                  Copy fees + seed from this rehearsal
                </button>
                <p className="mt-2 text-[0.6875rem] text-cream-muted">
                  Remembered in this browser only — not authoritative. Cross-check
                  against the run itself before trusting it for a real-value deploy.
                </p>
              </div>
            ) : (
              <p className="mt-3 text-xs text-cream-muted">
                No testnet rehearsal recorded in this browser for this
                collection address yet. Not required — but strongly
                recommended: go back and rehearse first if you have not.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <div className="mt-3 rounded-md border border-line bg-panel-soft p-3">
        <h3 className={LABEL}>Immutable — get these right before dispatching</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={LABEL}>Collection (NFT contract, ERC-721) — IMMUTABLE</span>
            <input
              className={`${INPUT} mt-1 font-mono text-xs`}
              placeholder="0x…"
              value={input.collection}
              onChange={(e) => set("collection", e.target.value)}
              spellCheck={false}
            />
            {problemFor("collection") ? (
              <p className="mt-1 text-xs text-rose-400">{problemFor("collection")}</p>
            ) : null}
            {pendingVaults.length > 0 ? (
              <span className="mt-1 flex flex-wrap gap-1.5">
                {pendingVaults.map((c) => (
                  <button
                    key={c.slug}
                    type="button"
                    className={`${BUTTON_SECONDARY} h-7 px-2 text-[0.5625rem]`}
                    onClick={() => set("collection", c.contractAddress)}
                  >
                    Use {c.name}
                  </button>
                ))}
              </span>
            ) : null}
          </label>

          <label className="block">
            <span className={LABEL}>Share token name — IMMUTABLE</span>
            <input
              className={`${INPUT} mt-1`}
              value={input.shareName}
              onChange={(e) => set("shareName", e.target.value)}
            />
            <p className="mt-1 text-[0.6875rem] text-cream-muted">
              Defaults to RobinWood&apos;s own — change it for any other
              collection, or its share token stays branded RobinWood forever.
            </p>
            {problemFor("shareName") ? (
              <p className="mt-1 text-xs text-rose-400">{problemFor("shareName")}</p>
            ) : null}
          </label>
          <label className="block">
            <span className={LABEL}>Share token symbol — IMMUTABLE</span>
            <input
              className={`${INPUT} mt-1 font-mono`}
              value={input.shareSymbol}
              onChange={(e) => set("shareSymbol", e.target.value.toUpperCase())}
              spellCheck={false}
            />
            {problemFor("shareSymbol") ? (
              <p className="mt-1 text-xs text-rose-400">{problemFor("shareSymbol")}</p>
            ) : null}
          </label>

          <label className="block sm:col-span-2">
            <span className={LABEL}>
              Treasury — IMMUTABLE, must equal the deploy key&apos;s address
            </span>
            <input
              className={`${INPUT} mt-1 font-mono text-xs`}
              placeholder="0x… (blank on testnet defaults to the signer)"
              value={input.treasury}
              onChange={(e) => set("treasury", e.target.value)}
              spellCheck={false}
            />
            <p className="mt-1 text-[0.6875rem] text-cream-muted">
              Not auto-filled from your connected wallet on purpose — the
              wallet signing this dispatch and the key the workflow deploys
              with are different keys. The workflow enforces the match; this
              app cannot verify it for you.
            </p>
            {problemFor("treasury") ? (
              <p className="mt-1 text-xs text-rose-400">{problemFor("treasury")}</p>
            ) : null}
          </label>

          <WeiField
            label="mintFeeWei — IMMUTABLE, must be > 0, ≤ 0.05 ETH"
            hint="Paid per NFT deposited"
            value={input.mintFeeWei}
            onChange={(v) => set("mintFeeWei", v)}
            problem={problemFor("mintFeeWei")}
          />
          <WeiField
            label="redeemFeeWei — IMMUTABLE, must be > 0, ≤ 0.05 ETH"
            hint="Paid per random redeem request"
            value={input.redeemFeeWei}
            onChange={(v) => set("redeemFeeWei", v)}
            problem={problemFor("redeemFeeWei")}
          />
          <WeiField
            label="targetPremiumWei — IMMUTABLE, ≤ 0.1 ETH"
            hint="Extra fee for a targeted (non-random) redeem"
            value={input.targetPremiumWei}
            onChange={(v) => set("targetPremiumWei", v)}
            problem={problemFor("targetPremiumWei")}
          />
          <label className="block">
            <span className={LABEL}>swapFeeBps — IMMUTABLE, ≤ 100 (RobinWood runs 30)</span>
            <input
              className={`${INPUT} mt-1`}
              type="number"
              min={0}
              max={100}
              value={input.swapFeeBps}
              onChange={(e) => set("swapFeeBps", e.target.value)}
            />
            {problemFor("swapFeeBps") ? (
              <p className="mt-1 text-xs text-rose-400">{problemFor("swapFeeBps")}</p>
            ) : null}
          </label>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-line bg-panel-soft p-3">
        <h3 className={LABEL}>Seed (deposited by the treasury, before opening)</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Seed token IDs (comma/space separated)</span>
            <input
              className={`${INPUT} mt-1 font-mono text-xs`}
              placeholder="1, 2, 3"
              value={input.seedTokenIds}
              onChange={(e) => set("seedTokenIds", e.target.value)}
              spellCheck={false}
            />
            {problemFor("seedTokenIds") ? (
              <p className="mt-1 text-xs text-rose-400">{problemFor("seedTokenIds")}</p>
            ) : null}
          </label>
          <WeiField
            label="Seed ETH (wei)"
            hint="Locked forever once the pool opens"
            value={input.seedEthWei}
            onChange={(v) => set("seedEthWei", v)}
            problem={problemFor("seedEthWei")}
          />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-cream">
          <input
            type="checkbox"
            checked={input.confirmOpen}
            onChange={(e) => set("confirmOpen", e.target.checked)}
          />
          Also call the one-way <code className="font-mono text-xs">openPool()</code> once
          seeded (leave unchecked to deploy + seed only, and open manually later)
        </label>
      </div>

      {state.kind === "invalid" ? (
        <p className={NOTE_ERR}>Fix the highlighted fields above before dispatching.</p>
      ) : state.kind === "error" ? (
        <p className={NOTE_ERR}>{state.message}</p>
      ) : state.kind === "done" ? (
        <p className={NOTE_OK}>
          Dispatched to {state.network === "robinhood" ? "mainnet" : "testnet"}.{" "}
          {state.runUrl ? (
            <a href={state.runUrl} target="_blank" rel="noreferrer" className="underline">
              View the run
            </a>
          ) : (
            <>
              Run link not available yet —{" "}
              <a href={state.actionsUrl} target="_blank" rel="noreferrer" className="underline">
                check the Actions tab
              </a>
              .
            </>
          )}{" "}
          {state.network === "robinhood-testnet" ? (
            <>
              Recorded as a rehearsal for this collection — use{" "}
              <strong className="text-cream">Skip ahead: deploy to mainnet instead</strong> above
              once it looks right to carry these values forward.
            </>
          ) : (
            <>
              After it finishes, paste the deployed vault address into the staged
              entry above and Sign &amp; save.
            </>
          )}
        </p>
      ) : null}

      <button
        type="button"
        className={`${BUTTON_PRIMARY} mt-4`}
        onClick={() => void submit()}
        disabled={!address || busy || configured !== true}
      >
        {state.kind === "signing"
          ? "Sign in wallet…"
          : state.kind === "dispatching"
            ? "Dispatching…"
            : isMainnet
              ? "Sign & dispatch to mainnet"
              : "Sign & dispatch to testnet"}
      </button>
      {!address ? (
        <p className="mt-2 text-xs text-cream-muted">Connect an admin wallet to dispatch.</p>
      ) : null}
    </section>
  );
}

// --- staged ---------------------------------------------------------------

function StagedCollectionsCard({ address }: { address: string | null }) {
  const { doc, dirty, save, load, mutate, persist } =
    useContentDocCard<CollectionsDoc>("collections", sanitizeCollections, address);
  const [draft, setDraft] = useState<StagedCollection>(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState<string | null>(null);

  const addDraft = useCallback(() => {
    setDraftError(null);
    if (!doc) return;
    const candidate = {
      ...draft,
      slug:
        draft.slug.trim() ||
        draft.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 64),
    };
    const parsed = sanitizeCollections({ staged: [...doc.staged, candidate] });
    if (!parsed.ok) {
      setDraftError(parsed.message);
      return;
    }
    mutate(() => parsed.value);
    setDraft(EMPTY_DRAFT);
  }, [doc, draft, mutate]);

  return (
    <CardChrome
      title="Staged"
      subtitle="Next up — reviewed here, promoted to live by a release"
      dirty={dirty}
      save={save}
      onReload={() => void load()}
      onSave={() => void persist()}
      canSave={!!address && doc !== null}
    >
      <p className="mt-3 text-xs text-cream-muted">
        Record a collection here once it&apos;s reviewed (contract verified,
        provenance checked). Staging doesn&apos;t change the site — it makes the
        release that promotes it a copy-paste with the decisions already made.
      </p>
      {doc === null ? (
        <p className="mt-3 text-sm text-cream-muted">Loading…</p>
      ) : (
        <>
          {doc.staged.length === 0 ? (
            <p className="mt-3 text-sm text-cream-muted">
              Nothing staged yet — add the first candidate below.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {doc.staged.map((c, i) => (
                <li
                  key={c.slug}
                  className="flex flex-wrap items-start gap-2 rounded-md border border-line bg-panel-soft p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-cream">
                        {c.name}
                      </span>
                      <Chip tone="info">{c.tokenStandard}</Chip>
                      <Chip tone={c.feeBps > 0 ? "on" : "off"}>
                        fee {c.feeBps === 0 ? "0 (free)" : `${c.feeBps} bps`}
                      </Chip>
                      <Chip tone={c.vaultAddress ? "on" : "off"}>
                        {c.vaultAddress ? "vault" : "trading only"}
                      </Chip>
                    </div>
                    <p className="mt-1 break-all text-xs text-cream-muted">
                      <ExplorerAddress address={c.contractAddress} />
                    </p>
                    {c.vaultAddress ? (
                      <p className="mt-0.5 break-all text-xs text-cream-muted">
                        vault <ExplorerAddress address={c.vaultAddress} />
                      </p>
                    ) : null}
                    {c.notes ? (
                      <p className="mt-1 text-xs text-cream-muted">{c.notes}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${c.name}`}
                    className={`${BUTTON_SECONDARY} w-11 px-0 text-rose-400`}
                    onClick={() =>
                      mutate((prev) => ({
                        staged: prev.staged.filter((_, j) => j !== i),
                      }))
                    }
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 rounded-md border border-line bg-panel-soft p-3">
            <h3 className={LABEL}>Stage a collection</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className={LABEL}>Collection name</span>
                <input
                  className={`${INPUT} mt-1`}
                  placeholder="e.g. Oakfolk"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, name: e.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className={LABEL}>NFT contract address</span>
                <input
                  className={`${INPUT} mt-1 font-mono text-xs`}
                  placeholder="0x…"
                  value={draft.contractAddress}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, contractAddress: e.target.value }))
                  }
                  spellCheck={false}
                />
              </label>
              <label className="block">
                <span className={LABEL}>Token standard</span>
                <select
                  className={`${INPUT} mt-1`}
                  value={draft.tokenStandard}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      tokenStandard: e.target.value as "ERC721" | "ERC1155",
                    }))
                  }
                >
                  <option value="ERC721">ERC721</option>
                  <option value="ERC1155">ERC1155</option>
                </select>
              </label>
              <label className="block">
                <span className={LABEL}>
                  Marketplace fee · basis points (50 = 0.5%)
                </span>
                <input
                  className={`${INPUT} mt-1`}
                  type="number"
                  min={0}
                  max={1000}
                  value={draft.feeBps}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, feeBps: Number(e.target.value) }))
                  }
                />
              </label>
              <label className="block sm:col-span-2">
                <span className={LABEL}>
                  Instant Swap vault address (optional — leave empty for
                  trading only; ERC721 only)
                </span>
                <input
                  className={`${INPUT} mt-1 font-mono text-xs`}
                  placeholder="0x… (fill in after the vault is deployed)"
                  value={draft.vaultAddress}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, vaultAddress: e.target.value }))
                  }
                  spellCheck={false}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className={LABEL}>
                  Notes (diligence, provenance, links)
                </span>
                <input
                  className={`${INPUT} mt-1`}
                  value={draft.notes}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, notes: e.target.value }))
                  }
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-cream-muted">
              The fee is charged on this collection&apos;s marketplace trades
              and accrues to the Marketplank treasury. RobinWood stays 0 by
              design.
            </p>
            {draftError ? (
              <p className="mt-2 text-sm text-rose-400">{draftError}</p>
            ) : null}
            <button
              type="button"
              className={`${BUTTON_SECONDARY} mt-3`}
              onClick={addDraft}
            >
              Stage collection
            </button>
          </div>
        </>
      )}
    </CardChrome>
  );
}
