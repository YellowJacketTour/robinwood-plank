import { createHash } from "node:crypto";
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { enqueueDataJob } from "@/lib/market/multichain/control-plane";
import { hydrationJobSources, DEMAND_PRIORITY } from "@/lib/market/multichain/collection-demand";

/**
 * ONE demand bus.
 *
 * Before: viewport visibility had its own route + priority schedule
 * (collection-demand.ts, still the authority for the viewport tier), a
 * detail-page open had prioritizeCollectionDemand, and hover / search /
 * wallet-connect / sweep intent published nothing at all. Focus could not
 * follow intent or money because the mesh never heard about either.
 *
 * Now every intent kind lands on the same bus and the same queue
 * (plank_data_jobs via enqueueDataJob, so the mesh's dedup/ratchet/fair-
 * claim logic is reused, not duplicated) with
 *
 *   priority = f(users watching, money at stake, staleness, cost to refresh)
 *
 * computed by computeIntentPriority -- a pure, unit-tested function, so the
 * schedule is explainable rather than a pile of magic numbers. Distinct
 * watchers are counted from plank_demand_intents (migration 099), keyed by
 * a salted hash of the client, never a raw IP.
 *
 * Boundaries kept on purpose:
 *   - The bus never calls a vendor. It only changes what the mesh does
 *     next, exactly like prioritizeVisibleCollections.
 *   - Unknown collection keys are admitted only at DEMAND_PRIORITY.
 *     UNKNOWN_KEY, same as the visibility route, so junk cannot skip the
 *     line (docs/marketplank/GROK-FINDINGS-sustainable-archival-mining-
 *     2026-08-25.md §C).
 */

export type IntentKind = "viewport" | "hover" | "click" | "search" | "wallet-connect" | "sweep" | "facet" | "read";

export type DemandIntent = {
  kind: IntentKind;
  chainSlug: string;
  /** Collection keys (0x address, ME symbol, Helius mint, UniSat collectionId). */
  subjects: string[];
  /** Real money the user has put in play for this subject (sweep total, offer size) in USD; 0 when unknown. */
  moneyAtStakeUsd?: number;
  /** Token ids the intent is about (sweep targets, next grid page, facet members) -- bounded. */
  tokenIds?: string[];
  context?: string;
};

/** Base priority per intent, on the same scale as DEMAND_PRIORITY (BACKGROUND 50, VISIBLE 110, VISIBLE_STALE_AGED 120). */
export const INTENT_BASE_PRIORITY: Record<IntentKind, number> = {
  read: 60,
  viewport: DEMAND_PRIORITY.VISIBLE,
  hover: 100,
  search: 104,
  facet: 108,
  "wallet-connect": 112,
  click: 118,
  sweep: 124,
};

/** Hard ceiling. Above VISIBLE_STALE_AGED so real money can outrank an aged viewport, but bounded so nothing pins forever. */
export const INTENT_MAX_PRIORITY = 130;

export type IntentPriorityInput = {
  kind: IntentKind;
  /** Distinct clients that expressed intent on this subject in the recent window. */
  watchers: number;
  moneyAtStakeUsd: number;
  /** Time since the subject's last real hydrate; null = never hydrated (treated as maximally stale). */
  stalenessMs: number | null;
  /** Vendor cost units a refresh of this subject is expected to burn (1 = one cheap call; ~50+ = a full walk). */
  refreshCostUnits: number;
  /** True when the key is not in plank_multichain_collections. */
  unknownKey?: boolean;
};

/**
 * priority = base(kind)
 *          + watchers boost      (log2 -- the 2nd watcher matters more than the 20th)   ≤ +8
 *          + money boost         (log10 -- $10 → +2, $100 → +4, $1k → +6, $10k → +8)   ≤ +10
 *          + staleness boost     (+1 per 10 minutes stale, never hydrated = max)         ≤ +6
 *          − cost penalty        (−1 per 50 cost units)                                  ≤ −6
 * clamped to [DEMAND_PRIORITY.ARCHIVAL_FRONTIER, INTENT_MAX_PRIORITY]; unknown keys are
 * pinned to DEMAND_PRIORITY.UNKNOWN_KEY regardless.
 */
export function computeIntentPriority(input: IntentPriorityInput): number {
  if (input.unknownKey) return DEMAND_PRIORITY.UNKNOWN_KEY;
  const base = INTENT_BASE_PRIORITY[input.kind];
  const watchers = Math.max(0, Math.floor(input.watchers));
  const watcherBoost = Math.min(8, Math.floor(Math.log2(1 + watchers)) * 2);
  const usd = Math.max(0, input.moneyAtStakeUsd);
  const moneyBoost = Math.min(10, Math.floor(Math.log10(1 + usd)) * 2);
  const stalenessBoost = input.stalenessMs == null ? 6 : Math.min(6, Math.floor(Math.max(0, input.stalenessMs) / (10 * 60_000)));
  const costPenalty = Math.min(6, Math.floor(Math.max(0, input.refreshCostUnits) / 50));
  const raw = base + watcherBoost + moneyBoost + stalenessBoost - costPenalty;
  return Math.max(DEMAND_PRIORITY.ARCHIVAL_FRONTIER, Math.min(INTENT_MAX_PRIORITY, raw));
}

const WATCH_WINDOW_MS = 2 * 60_000;
const MAX_SUBJECTS = 40;
const MAX_TOKEN_IDS = 48;

function normalizeKey(key: string): string {
  const s = key.trim();
  return /^0x[0-9a-f]{40}$/i.test(s) ? s.toLowerCase() : s;
}

/** Stable, non-reversible client identity for watcher counting. Salted per deployment. */
export function clientHash(ip: string, userAgent: string | null | undefined): string {
  const salt = process.env.DEMAND_BUS_SALT?.trim() || process.env.CRON_SECRET?.trim() || "plank-demand-bus";
  return createHash("sha256").update(`${salt}|${ip}|${userAgent ?? ""}`).digest("hex").slice(0, 24);
}

type SubjectFacts = { known: boolean; stalenessMs: number | null; watchers: number };

async function readSubjectFacts(chainSlug: string, subjects: string[]): Promise<Map<string, SubjectFacts>> {
  const facts = new Map<string, SubjectFacts>();
  for (const s of subjects) facts.set(s, { known: false, stalenessMs: null, watchers: 0 });
  if (!hasPostgresConfig() || subjects.length === 0) return facts;
  const known = await postgresQuery<{ contract_address: string; synced_at: Date | null }>(
    `SELECT c.contract_address, s.synced_at
       FROM plank_multichain_collections c
       LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
      WHERE c.chain_slug = $1 AND c.contract_address = ANY($2::text[])`,
    [chainSlug, subjects]
  ).catch(() => ({ rows: [] as Array<{ contract_address: string; synced_at: Date | null }> }));
  const now = Date.now();
  for (const row of known.rows) {
    const f = facts.get(row.contract_address);
    if (!f) continue;
    f.known = true;
    f.stalenessMs = row.synced_at ? Math.max(0, now - new Date(row.synced_at).getTime()) : null;
  }
  const watchers = await postgresQuery<{ subject: string; watchers: string }>(
    `SELECT subject, COUNT(DISTINCT client_hash)::text AS watchers
       FROM plank_demand_intents
      WHERE chain_slug = $1 AND subject = ANY($2::text[]) AND last_seen_at >= NOW() - ($3::text || ' milliseconds')::interval
      GROUP BY subject`,
    [chainSlug, subjects, WATCH_WINDOW_MS]
  ).catch(() => ({ rows: [] as Array<{ subject: string; watchers: string }> }));
  for (const row of watchers.rows) {
    const f = facts.get(row.subject);
    if (f) f.watchers = Number(row.watchers);
  }
  return facts;
}

/**
 * Expected vendor cost of refreshing one collection's demand job set --
 * derived from which sources are still incomplete for it (a finished
 * collection enqueues nothing and costs nothing). Coarse on purpose: the
 * penalty term only needs to separate "one stats call" from "a full walk".
 */
function estimateRefreshCost(sources: Array<{ source: string }>): number {
  let cost = 0;
  for (const s of sources) {
    if (/membership|backfill|token-index-probe/.test(s.source)) cost += 60;
    else if (/metadata|rarity/.test(s.source)) cost += 40;
    else cost += 1;
  }
  return cost;
}

export type PublishResult = {
  accepted: number;
  enqueued: number;
  /** Per-subject explanation -- the "learned, explainable, logged" requirement in one object. */
  decisions: Array<{ subject: string; priority: number; watchers: number; known: boolean; sources: string[] }>;
};

/**
 * Publish one intent to the bus. Records the watcher row, computes the
 * priority for each subject and (re)enqueues that subject's real,
 * still-incomplete hydration jobs at that priority. Never throws into a
 * request handler for bookkeeping reasons; a failed enqueue is reported
 * in the counts, not hidden.
 */
export async function publishIntent(intent: DemandIntent, client: { hash: string }): Promise<PublishResult> {
  if (intent.kind === "wallet-connect" && intent.chainSlug === "all") return publishWalletConnect(intent, client);
  const subjects = [...new Set(intent.subjects.map(normalizeKey).filter(Boolean))].slice(0, MAX_SUBJECTS);
  const result: PublishResult = { accepted: subjects.length, enqueued: 0, decisions: [] };
  if (subjects.length === 0) return result;
  const money = Number.isFinite(intent.moneyAtStakeUsd) ? Math.max(0, Number(intent.moneyAtStakeUsd)) : 0;

  if (hasPostgresConfig()) {
    await postgresQuery(
      `INSERT INTO plank_demand_intents (chain_slug, subject, kind, client_hash, money_at_stake_usd, hits, first_seen_at, last_seen_at)
       SELECT $1, s, $2, $3, $4, 1, NOW(), NOW() FROM UNNEST($5::text[]) AS s
       ON CONFLICT (chain_slug, subject, kind, client_hash) DO UPDATE SET
         hits = plank_demand_intents.hits + 1,
         money_at_stake_usd = GREATEST(plank_demand_intents.money_at_stake_usd, EXCLUDED.money_at_stake_usd),
         last_seen_at = NOW()`,
      [intent.chainSlug, intent.kind, client.hash, money, subjects]
    ).catch(() => undefined);
  }

  const facts = await readSubjectFacts(intent.chainSlug, subjects);
  const tokenIds = (intent.tokenIds ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, MAX_TOKEN_IDS);

  await Promise.all(
    subjects.map(async (subject) => {
      const f = facts.get(subject) ?? { known: false, stalenessMs: null, watchers: 0 };
      const sources = f.known ? await hydrationJobSources(intent.chainSlug, subject).catch(() => []) : [];
      const priority = computeIntentPriority({
        kind: intent.kind,
        watchers: Math.max(f.watchers, 1),
        moneyAtStakeUsd: money,
        stalenessMs: f.stalenessMs,
        refreshCostUnits: estimateRefreshCost(sources),
        unknownKey: !f.known,
      });
      result.decisions.push({ subject, priority, watchers: f.watchers, known: f.known, sources: sources.map((s) => s.source) });
      if (!f.known) return;
      for (const { source } of sources) {
        try {
          await enqueueDataJob({
            // Same job key the detail-page path uses, so the mesh dedups the two.
            jobKey: `demand:${source}:${intent.chainSlug}:${subject}`,
            kind: `mesh-lane:${intent.chainSlug}`,
            source,
            chainSlug: intent.chainSlug,
            subject,
            priority,
            payload: {
              intent: intent.kind,
              context: intent.context ?? null,
              ...(tokenIds.length > 0 ? { focusTokenIds: tokenIds } : {}),
            },
          });
          result.enqueued += 1;
        } catch {
          // reported through enqueued count only
        }
      }
    })
  );
  return result;
}

/**
 * A wallet just connected: what it holds is what its owner will open next.
 * Resolve the wallet's collections per foreign EVM chain through the edge
 * (the same `owned` cells owned-all/route.ts reads, so this costs nothing
 * extra when that tab is open and at most one Alchemy call per chain per
 * TTL window otherwise), then publish one wallet-connect intent per chain
 * with the collections it actually holds as subjects. Solana/Bitcoin
 * holdings are not resolved here (no keyless owned-by-wallet source is
 * wired for them); that is an honest gap, not a fabricated empty.
 */
async function publishWalletConnect(intent: DemandIntent, client: { hash: string }): Promise<PublishResult> {
  const owner = intent.subjects[0]?.trim();
  const result: PublishResult = { accepted: owner ? 1 : 0, enqueued: 0, decisions: [] };
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return result;
  const [{ FOREIGN_CHAINS }, { edgeRead }, { meteredFetch }, { pickAlchemyKey }, { ALCHEMY_NETWORK_SUBDOMAIN }] = await Promise.all([
    import("@/lib/market/multichain/trading/foreign-chain-registry"),
    import("@/lib/market/multichain/edge/read-gateway"),
    import("@/lib/market/multichain/edge/provider-ledger"),
    import("@/lib/market/multichain/discovery/alchemy-key-pool"),
    import("@/lib/market/multichain/adapters/alchemy-network"),
  ]);
  const keyEntry = await pickAlchemyKey("live").catch(() => null);
  const apiKey = keyEntry?.apiKey || "demo";
  type OwnedItem = { chainSlug: string; contractAddress: string; collectionName: string | null; tokenId: string };
  const perChain = await Promise.all(
    FOREIGN_CHAINS.map(async (chain) => {
      const subdomain = ALCHEMY_NETWORK_SUBDOMAIN[chain.chainSlug];
      if (!subdomain || chain.chainSlug === "zksync-mainnet") return { chainSlug: chain.chainSlug, keys: [] as string[] };
      try {
        const { value } = await edgeRead<OwnedItem[]>(
          { kind: "owned", chainSlug: chain.chainSlug, subject: owner.toLowerCase(), variant: { scope: "all", pageSize: 50 } },
          async () => {
            const url = new URL(`https://${subdomain}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`);
            url.searchParams.set("owner", owner);
            url.searchParams.set("withMetadata", "true");
            url.searchParams.set("pageSize", "50");
            const res = await meteredFetch(url.toString(), undefined, { source: "alchemy-nft", keyId: keyEntry?.id ?? null, chainSlug: chain.chainSlug, costUnits: 480 });
            if (!res.ok) throw new Error(`Alchemy ${res.status}`);
            const data = (await res.json()) as { ownedNfts?: Array<{ tokenId: string; contract?: { address: string; name?: string | null } }> };
            return (data.ownedNfts ?? []).map((n) => ({ chainSlug: chain.chainSlug, contractAddress: n.contract?.address ?? "", collectionName: n.contract?.name ?? null, tokenId: n.tokenId }));
          },
          { provider: "alchemy" }
        );
        return { chainSlug: chain.chainSlug, keys: [...new Set(value.map((v) => v.contractAddress).filter(Boolean))] };
      } catch {
        return { chainSlug: chain.chainSlug, keys: [] as string[] };
      }
    })
  );
  for (const { chainSlug, keys } of perChain) {
    if (keys.length === 0) continue;
    const r = await publishIntent({ kind: "wallet-connect", chainSlug, subjects: keys, context: "wallet" }, client);
    result.enqueued += r.enqueued;
    result.decisions.push(...r.decisions);
  }
  return result;
}
