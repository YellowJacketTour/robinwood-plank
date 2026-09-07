import { postgresQuery } from "@/lib/postgres";
import { durableKv } from "@/lib/market/durable-kv";
import { chainManifest } from "@/lib/market/multichain/chains/manifest";
import { compareCollection, summarise, type CollectionParity, type ParityInput } from "./parity";
import { readCoinGeckoReference, readMagicEdenReference, readHiroInscriptionTotal, type Reference } from "./references";

/**
 * Parity lane: sample the chain's most active collections, read one or
 * two independent references for each, compare, and keep the verdicts
 * where the hub and the diagnostics endpoint can show them. A divergent
 * collection is also bumped for a fresh stats sync so disagreement turns
 * into work, not a warning.
 */
export const PARITY_SAMPLE = 20;

const rowKey = (chain: string, key: string) => `plank:parity:${chain}:${key.toLowerCase()}`;
const summaryKey = (chain: string) => `plank:parity-summary:${chain}`;

type Row = { contract_address: string; alias_symbol: string | null; floor_price_wei: string | null; listed_count: number | null; total_supply: number | null; sales_24h: number | null; volume_24h_wei: string | null };

function toNative(wei: string | null, decimals: number): number | null {
  if (wei == null) return null;
  try {
    return Number(BigInt(wei)) / 10 ** decimals;
  } catch {
    return null;
  }
}

export async function runParityLane(chainSlug: string, sample = PARITY_SAMPLE): Promise<{ sampled: number; agreement: number | null; coverage?: Record<string, number | null> }> {
  const rows = await postgresQuery<Row>(
    `SELECT c.contract_address, c.alias_symbol, s.floor_price_wei::text, s.listed_count, s.total_supply, s.sales_24h, s.volume_24h_wei::text
       FROM plank_multichain_collections c
       JOIN plank_multichain_snapshots s ON s.collection_id = c.id
      WHERE c.chain_slug = $1 AND s.floor_price_wei IS NOT NULL
      ORDER BY s.volume_24h_wei DESC NULLS LAST, s.holder_count DESC NULLS LAST
      LIMIT $2`,
    [chainSlug, sample]
  );
  const results: CollectionParity[] = [];
  for (const r of rows.rows) {
    const ours: ParityInput = {
      floor: toNative(r.floor_price_wei, 18),
      listed: r.listed_count,
      supply: r.total_supply,
      sales24h: r.sales_24h,
      volume24h: toNative(r.volume_24h_wei, 18),
    };
    const refs: Reference[] = [];
    if (chainSlug === "solana-mainnet") {
      const me = await readMagicEdenReference(r.alias_symbol ?? r.contract_address);
      if (me) refs.push(me);
    }
    const cg = await readCoinGeckoReference({ chainSlug, contractAddress: r.contract_address, coingeckoId: chainSlug === "solana-mainnet" || chainSlug === "bitcoin-mainnet" ? r.alias_symbol ?? r.contract_address : null });
    if (cg) refs.push(cg);
    // Compare against the best-agreeing reference: two independent sources
    // that disagree with each other are not evidence that we are wrong.
    const parities = refs.map((ref) => ({ ref, parity: compareCollection(ours, ref.values) }));
    const best = parities.sort((a, b) => ["match", "near", "diverge", "unverified"].indexOf(a.parity.verdict) - ["match", "near", "diverge", "unverified"].indexOf(b.parity.verdict))[0];
    const parity = best?.parity ?? compareCollection(ours, {});
    results.push(parity);
    await durableKv.set(rowKey(chainSlug, r.contract_address), { ours, references: refs, parity, at: new Date().toISOString() });
    if (parity.verdict === "diverge") {
      const { enqueueDataJob } = await import("@/lib/market/multichain/control-plane");
      await enqueueDataJob({
        jobKey: `parity-resync:${chainSlug}:${r.contract_address.toLowerCase()}`,
        kind: `mesh-lane:${chainSlug}`,
        source: chainSlug === "solana-mainnet" ? "magiceden-solana" : "opensea-stats",
        chainSlug,
        subject: r.contract_address,
        payload: { reason: "parity-diverge" },
        priority: 90,
      }).catch(() => undefined);
    }
  }
  const summary = summarise(results);
  let coverage: Record<string, number | null> | undefined;
  if (chainSlug === "bitcoin-mainnet") {
    const total = await readHiroInscriptionTotal();
    const ours = await postgresQuery<{ n: string }>(`SELECT COUNT(*)::text AS n FROM plank_collection_tokens WHERE chain_slug = 'bitcoin-mainnet'`).catch(() => ({ rows: [{ n: "0" }] }));
    coverage = { hiroInscriptionsTotal: total, inscriptionsHeld: Number(ours.rows[0]?.n ?? 0), share: total ? Number((Number(ours.rows[0]?.n ?? 0) / total).toFixed(4)) : null };
  }
  await durableKv.set(summaryKey(chainSlug), { ...summary, coverage: coverage ?? null, at: new Date().toISOString(), nativeSymbol: chainManifest(chainSlug)?.nativeCurrencySymbol ?? null });
  return { sampled: summary.sampled, agreement: summary.agreement, coverage };
}

export async function readParitySummaries(chainSlugs: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const c of chainSlugs) out[c] = (await durableKv.get(summaryKey(c))) ?? null;
  return out;
}

export async function readParityRows(chainSlug: string, keys: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (await durableKv.get(rowKey(chainSlug, k))) ?? null;
  return out;
}
