"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  DRAND_BEACON_ADDRESS,
  MARKET_FEE_RECIPIENT,
  MARKET_VAULT_ADDRESS,
} from "@/lib/constants";
import {
  sanitizeCollections,
  type CollectionsDoc,
  type StagedCollection,
} from "@/lib/content-docs";
import { useContentDocCard, CardChrome } from "./contentDocCard";
import { BUTTON_SECONDARY, CARD, INPUT, LABEL } from "../ui";

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

function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

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
            // Today the site's vault wiring is the global env pair, which
            // belongs to RobinWood; per-collection vaultAddress takes over
            // once populated.
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
                    <dd className="mt-0.5 break-all font-mono text-cream-muted">
                      {c.contractAddress}
                    </dd>
                  </div>
                  {vault ? (
                    <div>
                      <dt className={LABEL}>Vault contract</dt>
                      <dd className="mt-0.5 break-all font-mono text-cream-muted">
                        {vault}
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
      <VaultRunbookCard />
    </>
  );
}

// --- vault deploy runbook --------------------------------------------------

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-panel-strong px-3 py-2">
      <span className={`${LABEL} w-40 shrink-0`}>{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-xs text-cream">
        {value || "—"}
      </span>
      <button
        type="button"
        className={`${BUTTON_SECONDARY} h-8 px-2 text-[0.5625rem]`}
        disabled={!value}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Guided Layer-2 deployment. The signature deliberately stays in the LOCAL
 * deploy tool (scripts/deploy-tool — run from the repo, never hosted): the
 * treasury must sign bytecode verifiable against source on the operator's
 * machine, not whatever a production server serves. This card only removes
 * the transcription work: every constructor argument, pre-filled and
 * copyable.
 */
function VaultRunbookCard() {
  const [staged, setStaged] = useState<StagedCollection[]>([]);
  useEffect(() => {
    // One-shot fetch of the staged list for the prefill dropdown; failures
    // just leave the dropdown with live collections only.
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
  const [collectionAddress, setCollectionAddress] = useState("");
  const [shareName, setShareName] = useState("");
  const [shareSymbol, setShareSymbol] = useState("");
  const [mintFeeBps, setMintFeeBps] = useState("100");
  const [redeemFeeBps, setRedeemFeeBps] = useState("100");
  const [targetPremiumBps, setTargetPremiumBps] = useState("500");

  const prefill = useMemo(
    () => (name: string, address: string) => {
      setCollectionAddress(address);
      setShareName(`Marketplank ${name}`);
      setShareSymbol(
        `plk${name.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase()}`
      );
    },
    []
  );

  return (
    <section className={CARD}>
      <h2 className="font-display text-xl text-gold-300">
        Deploy a vault (runbook)
      </h2>
      <p className={`mt-1 ${LABEL}`}>
        Layer 2 — signed locally on purpose, never from this page
      </p>
      <p className="mt-3 text-xs text-cream-muted">
        The treasury wallet must sign bytecode it can verify against source,
        so deployment happens in the local tool (scripts/deploy-tool in the
        repo) — this card just fills in every value so nothing is
        hand-transcribed. Reminder: MarketplankVault has had no independent
        third-party audit; that call is yours each time.
      </p>

      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-cream">
        <li>
          <code className="font-mono text-xs">npx hardhat compile</code> in the
          repo root, then in <code className="font-mono text-xs">scripts/deploy-tool</code>:{" "}
          <code className="font-mono text-xs">npm install && npm run build</code>
        </li>
        <li>
          Copy the two artifact JSONs per the tool&apos;s README (re-copy after
          ANY contract change), then <code className="font-mono text-xs">npx serve .</code>
        </li>
        <li>Fill the tool&apos;s form with the values below; treasury signs.</li>
        <li>
          Paste the deployed vault address into the staged entry above and
          Sign &amp; save. Then seed liquidity and{" "}
          <code className="font-mono text-xs">openPool()</code> from the
          treasury — the vault deploys closed.
        </li>
      </ol>

      <div className="mt-4 rounded-md border border-line bg-panel-soft p-3">
        <h3 className={LABEL}>Constructor values</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <label className="block sm:col-span-1">
            <span className={LABEL}>Prefill from staged / live</span>
            <select
              className={`${INPUT} mt-1`}
              value=""
              onChange={(e) => {
                const [name, addr] = e.target.value.split("|");
                if (addr) prefill(name, addr);
              }}
            >
              <option value="">Pick a collection…</option>
              {MARKET_COLLECTIONS.filter((c) => c.tokenStandard === "ERC721").map(
                (c) => (
                  <option key={c.slug} value={`${c.name}|${c.contractAddress}`}>
                    {c.name} (live)
                  </option>
                )
              )}
              {staged
                .filter((c) => c.tokenStandard === "ERC721" && !c.vaultAddress)
                .map((c) => (
                  <option key={c.slug} value={`${c.name}|${c.contractAddress}`}>
                    {c.name} (staged)
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            <span className={LABEL}>Share name</span>
            <input
              className={`${INPUT} mt-1`}
              value={shareName}
              onChange={(e) => setShareName(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={LABEL}>Share symbol</span>
            <input
              className={`${INPUT} mt-1 font-mono`}
              value={shareSymbol}
              onChange={(e) => setShareSymbol(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={LABEL}>mintFeeBps (max 1000)</span>
            <input
              className={`${INPUT} mt-1`}
              type="number"
              min={0}
              max={1000}
              value={mintFeeBps}
              onChange={(e) => setMintFeeBps(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={LABEL}>redeemFeeBps (max 1000)</span>
            <input
              className={`${INPUT} mt-1`}
              type="number"
              min={0}
              max={1000}
              value={redeemFeeBps}
              onChange={(e) => setRedeemFeeBps(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={LABEL}>targetPremiumBps (max 2000)</span>
            <input
              className={`${INPUT} mt-1`}
              type="number"
              min={0}
              max={2000}
              value={targetPremiumBps}
              onChange={(e) => setTargetPremiumBps(e.target.value)}
            />
          </label>
        </div>
        <label className="mt-2 block">
          <span className={LABEL}>collection_ (NFT contract, ERC721)</span>
          <input
            className={`${INPUT} mt-1 font-mono text-xs`}
            placeholder="0x… — or pick above"
            value={collectionAddress}
            onChange={(e) => setCollectionAddress(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="mt-3 space-y-1.5">
          <CopyRow label="collection_" value={collectionAddress.trim()} />
          <CopyRow label="name_" value={shareName.trim()} />
          <CopyRow label="symbol_" value={shareSymbol.trim()} />
          <CopyRow label="mintFeeBps_" value={mintFeeBps} />
          <CopyRow label="redeemFeeBps_" value={redeemFeeBps} />
          <CopyRow label="targetPremiumBps_" value={targetPremiumBps} />
          <CopyRow label="treasury_" value={MARKET_FEE_RECIPIENT} />
          <CopyRow label="beacon_" value={DRAND_BEACON_ADDRESS} />
        </div>
        <p className="mt-2 text-xs text-cream-muted">
          treasury_ and beacon_ are the configured production values
          (lib/constants.ts). Verify the beacon against a drand mirror before
          any real-value deploy — see the tool&apos;s README.
        </p>
      </div>
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
                        {c.vaultAddress
                          ? `vault ${shortAddr(c.vaultAddress)}`
                          : "trading only"}
                      </Chip>
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-cream-muted">
                      {c.contractAddress}
                    </p>
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
