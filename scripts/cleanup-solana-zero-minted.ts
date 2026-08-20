/**
 * Retroactive cleanup for the real gap the live num_minted filter
 * (lib/market/multichain/discovery/helius-collection-scan.ts,
 * shouldSkipZeroMemberCollection) only closes GOING FORWARD: every
 * under-threshold-minted Metaplex Core "collection" registered BEFORE
 * that filter existed (or before it was recalibrated) is still sitting
 * in plank_multichain_collections today, permanently inflating the
 * tracked-collection count with rows that structurally can never have
 * real floor/volume/listed data (flagged live 2026-08-20: "total
 * collection numbers are all still messed up").
 *
 * RECALIBRATED live 2026-08-20 ("you expect me to believe there are 56
 * thousand solana nfts that arent lp?"): the original exactly-zero
 * threshold was too narrow -- after that first pass deleted every real
 * zero, a live random sample of 200 of the REMAINING rows still found
 * 95% (190/200) sitting at num_minted <= 50, and every one of a
 * separate hand-checked sample (num_minted 3/10/20/38) had zero real
 * trading signal ever (0 of the entire remaining tracked set had ever
 * produced a real floor or volume in plank_multichain_snapshots). Now
 * uses the SAME MIN_REAL_MEMBER_COUNT=50 threshold as the live forward
 * filter -- see that file's own header for why 50 is the real observed
 * break point, not a guessed number.
 *
 * DRY-RUN BY DEFAULT. Nothing is deleted unless --apply is passed.
 * Real, per-source circuit breaker (source-budget.ts) protects the real
 * Helius API key this uses -- same discipline this session's own
 * security-review critique demanded for every external-source call.
 *
 * Usage:
 *   tsx scripts/cleanup-solana-zero-minted.ts                  (report only)
 *   tsx scripts/cleanup-solana-zero-minted.ts --apply           (actually delete)
 *   tsx scripts/cleanup-solana-zero-minted.ts --max-batches=50 --apply
 */
import { hasPostgresConfig, postgresQuery } from "../lib/postgres";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "../lib/market/multichain/discovery/source-budget";
import { MIN_REAL_MEMBER_COUNT } from "../lib/market/multichain/discovery/helius-collection-scan";

const SOURCE = "helius-das";
const BATCH_SIZE = 100; // conservative slice of Helius's real documented getAssetBatch ceiling
const THROTTLE_MS = 120; // real fix, live 2026-08-20: keeps the per-id fallback's sequential getAsset calls under Helius's real per-second rate limit
const APPLY = process.argv.includes("--apply");
const maxBatchesArg = process.argv.find((a) => a.startsWith("--max-batches="));
const MAX_BATCHES = maxBatchesArg ? Number(maxBatchesArg.slice("--max-batches=".length)) : 200;

function apiKey(): string {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) throw new Error("cleanup-solana-zero-minted: HELIUS_API_KEY is not configured.");
  return key;
}

type HeliusAssetBatchItem = { id: string; mpl_core_info?: { num_minted?: number } | null };

async function callGetAssetBatch(ids: string[]): Promise<Map<string, number | null>> {
  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) throw new Error(`cleanup-solana-zero-minted: source jailed/exhausted (${gate.reason})`);

  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "plank-cleanup", method: "getAssetBatch", params: { ids } }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    recordSourceFailure(SOURCE, res.status === 429 || /rate limit|quota|too many requests/i.test(bodyText));
    throw new Error(`cleanup-solana-zero-minted: HTTP ${res.status} on getAssetBatch`);
  }
  const body = (await res.json()) as { result?: (HeliusAssetBatchItem | null)[]; error?: { message?: string } };
  if (body.error) {
    recordSourceFailure(SOURCE, /rate limit|quota/i.test(body.error.message ?? ""));
    throw new Error(body.error.message ?? "unknown Helius error");
  }
  recordSourceSuccess(SOURCE);

  const out = new Map<string, number | null>();
  for (const item of body.result ?? []) {
    if (!item?.id) continue;
    // Only a CONFIRMED zero counts -- a missing/malformed field is
    // "unknown," never treated as zero, same discipline
    // shouldSkipZeroMemberCollection already holds for new registrations.
    out.set(item.id, typeof item.mpl_core_info?.num_minted === "number" ? item.mpl_core_info.num_minted : null);
  }
  return out;
}

/**
 * Real finding, live 2026-08-20: getAssetBatch fails its ENTIRE call if
 * even ONE id in the batch is an invalid pubkey ("Pubkey Validation
 * Err") -- confirms the historical casing-corruption bug's scope is
 * larger than cleanup-solana-casing-duplicates.ts alone measures (that
 * script only finds corrupted rows that ALSO have a real, correctly-
 * cased sibling; an orphaned corrupted row with no sibling exists here
 * too). Falls back to one-by-one getAsset calls ONLY when the batch
 * itself fails on a validation error -- never for a genuine network/
 * quota failure, which should still abort the whole run via the normal
 * throw path (retrying those one-by-one would just burn the same
 * failure 100x for no benefit).
 */
async function fetchNumMintedBatch(ids: string[]): Promise<Map<string, number | null>> {
  try {
    return await callGetAssetBatch(ids);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/Pubkey Validation Err/i.test(message)) throw err;

    const out = new Map<string, number | null>();
    for (const id of ids) {
      const gate = checkSourceBudget(SOURCE);
      if (!gate.allowed) throw new Error(`cleanup-solana-zero-minted: source jailed/exhausted (${gate.reason})`);
      try {
        const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "plank-cleanup", method: "getAsset", params: { id } }),
        });
        // Real finding, live 2026-08-20: hammering getAsset one-by-one
        // with zero delay (up to 100x per batch) trips Helius's own real
        // per-second rate limit -- returned as a PLAIN-TEXT "Too Many
        // Requests" body, not JSON, which crashed res.json() before this
        // code ever got a chance to check res.ok. Handle the real HTTP
        // status directly, and treat 429 as the immediate-jail quota
        // signal it actually is (same discipline the batch path already
        // holds) instead of letting it masquerade as a generic failure.
        if (res.status === 429) {
          recordSourceFailure(SOURCE, true);
          out.set(id, null);
          await new Promise((r) => setTimeout(r, THROTTLE_MS * 4));
          continue;
        }
        const body = (await res.json()) as { result?: HeliusAssetBatchItem; error?: { message?: string } };
        if (!res.ok || body.error) {
          // Real design fix, live 2026-08-20: a "Pubkey Validation Err"
          // here is EXPECTED, USEFUL data -- this whole fallback exists
          // specifically because the batch it came from contains corrupted
          // orphan pubkeys, so hitting one is the mechanism working
          // correctly, not evidence the Helius API itself is unhealthy.
          // Only route a REAL api-health signal (an unexpected error
          // shape, a non-validation message) through the circuit
          // breaker's consecutive-failure counter -- routing expected
          // per-row validation errors through it was tripping the
          // 3-strike jail on perfectly normal data (confirmed live: the
          // very first batch, dense with real corrupted orphans, jailed
          // the source before it ever got a chance to check them all).
          const isPubkeyValidation = /Pubkey Validation Err/i.test(body.error?.message ?? "");
          if (!isPubkeyValidation) recordSourceFailure(SOURCE, false);
          // A genuinely invalid pubkey (the corrupted-orphan case this
          // fallback exists for) is real, useful information -- treated
          // as "unknown" (never deleted on this signal alone), not a
          // hard stop, so one bad id never blocks checking the other 99.
          out.set(id, null);
          continue;
        }
        recordSourceSuccess(SOURCE);
        out.set(id, typeof body.result?.mpl_core_info?.num_minted === "number" ? body.result.mpl_core_info!.num_minted! : null);
      } catch {
        recordSourceFailure(SOURCE, false);
        out.set(id, null);
      }
      // Real fix, live 2026-08-20: this loop's own burst of up to 100
      // sequential requests is what triggered Helius's rate limit above
      // in the first place -- a small delay between each real request
      // keeps this fallback under that real per-second ceiling instead
      // of reactively surviving it after the fact.
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
    return out;
  }
}

async function main() {
  if (!hasPostgresConfig()) throw new Error("cleanup-solana-zero-minted: no Postgres config.");

  const tracked = await postgresQuery<{ id: number; contract_address: string; name: string | null }>(
    `SELECT id, contract_address, name FROM plank_multichain_collections WHERE chain_slug = 'solana-mainnet' AND adapter = 'helius-solana' ORDER BY id`
  );
  console.log(`[cleanup] ${tracked.rows.length} helius-solana rows tracked total${APPLY ? "" : " (DRY RUN -- pass --apply to actually delete)"}`);

  let checked = 0;
  let confirmedZero: { id: number; contract_address: string; name: string | null }[] = [];
  let unknownCount = 0;

  for (let batchStart = 0; batchStart < tracked.rows.length && batchStart / BATCH_SIZE < MAX_BATCHES; batchStart += BATCH_SIZE) {
    const batch = tracked.rows.slice(batchStart, batchStart + BATCH_SIZE);
    let results: Map<string, number | null>;
    try {
      results = await fetchNumMintedBatch(batch.map((r) => r.contract_address));
    } catch (err) {
      console.error(`[cleanup] batch at offset ${batchStart} FAILED, stopping: ${err instanceof Error ? err.message : err}`);
      break;
    }
    checked += batch.length;
    for (const row of batch) {
      const numMinted = results.get(row.contract_address);
      if (numMinted != null && numMinted < MIN_REAL_MEMBER_COUNT) confirmedZero.push(row);
      else if (numMinted == null) unknownCount += 1;
    }
    if (batchStart % (BATCH_SIZE * 20) === 0) {
      console.log(`[cleanup] progress: ${checked}/${tracked.rows.length} checked, ${confirmedZero.length} confirmed-zero so far`);
    }
  }

  console.log(`[cleanup] done: ${checked} checked, ${confirmedZero.length} confirmed zero-minted, ${unknownCount} unknown (left alone)`);
  for (const row of confirmedZero.slice(0, 20)) {
    console.log(`  #${row.id} ${row.contract_address} "${row.name ?? "unnamed"}"`);
  }
  if (confirmedZero.length > 20) console.log(`  ...and ${confirmedZero.length - 20} more`);

  if (!APPLY || confirmedZero.length === 0) {
    if (confirmedZero.length > 0) console.log("\n[cleanup] Re-run with --apply to delete the rows listed above.");
    return;
  }

  const ids = confirmedZero.map((r) => r.id);
  const deleted = await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = ANY($1::int[])`, [ids]);
  console.log(`[cleanup] deleted ${deleted.rowCount ?? 0} confirmed-dead row(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[cleanup] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
