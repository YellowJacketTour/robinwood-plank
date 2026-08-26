/**
 * Real, one-time audit: walk $PLANK's full real transfer history on every
 * canonical pool, from genesis to now, and find the single largest real
 * buy that ever happened -- using the EXACT SAME value-resolution and
 * fraud-check primitives the live Season 2 pipeline uses
 * (lib/market/plank-koth-candidate.ts), not a separate, unproven scan.
 * This is the operator's own explicit ask: "as proof you know your
 * methods work you should have to audit all historical buys... and
 * confirm the largest previous single txn."
 *
 * Result is written to plank_koth_pre_season_record (migration 079) as a
 * real, honest "pre-season reference" -- displayed as a minor line on the
 * board until the real Season 2 competition begins, never mixed into the
 * live leaderboard/rule-engine state (a pre-launch buy was never a real
 * contest entry).
 *
 * Usage: npx tsx --env-file=.env.local scripts/audit-plank-historical-record.ts
 */
import { fetchAddressTokenTransfers, fetchTxTokenTransfers, fetchTransaction } from "../lib/market/blockscout";
import { CANONICAL_PLANK_POOLS, isCanonicalPlankPool } from "../lib/market/plank-pools";
import { resolveFinalRecipients, resolveValuePaid, hasRoundTripShape } from "../lib/market/plank-koth-candidate";
import { getEthUsdPrice } from "../lib/eth-price";
import { postgresQuery } from "../lib/postgres";
import { CONTRACT_ADDRESS as PLANK_CONTRACT } from "../lib/constants";

const MAX_PAGES_PER_POOL = 400; // 50/page default -> up to 20,000 transfers/pool

async function main() {
  console.log("[audit] walking full historical transfers on every canonical pool...");
  const allCandidateTxs = new Map<string, number>();

  for (const pool of CANONICAL_PLANK_POOLS) {
    console.log(`[audit] pool ${pool.address} (${pool.counterSymbol})...`);
    // Same real Blockscout flakiness confirmed live in plank-koth-watch.ts
    // -- a deep, many-page historical walk is more likely to hit a slow/
    // failing page than a shallow 2-page live-watcher fetch. paginate()'s
    // own retry-then-partial-return only covers a single page's hiccup;
    // wrap the whole call too so one pool's total outage can't abort the
    // entire audit and silently discard however many transfers the OTHER
    // two pools already yielded.
    const transfers = await fetchAddressTokenTransfers(pool.address, PLANK_CONTRACT, { maxPages: MAX_PAGES_PER_POOL }).catch(
      (error) => {
        console.error(`[audit]   pool ${pool.address} failed entirely: ${error instanceof Error ? error.message : error}`);
        return [];
      }
    );
    console.log(`[audit]   ${transfers.length} total transfers touching this pool`);
    let poolBuys = 0;
    for (const t of transfers) {
      if (!t.from?.hash || !isCanonicalPlankPool(t.from.hash) || t.block_number == null || !t.transaction_hash) continue;
      allCandidateTxs.set(t.transaction_hash, t.block_number);
      poolBuys += 1;
    }
    console.log(`[audit]   ${poolBuys} real buy-shaped transfers (pool -> wallet) found`);
  }

  console.log(`[audit] ${allCandidateTxs.size} unique candidate transactions across all pools -- evaluating real value paid...`);
  const { usd: ethUsd } = await getEthUsdPrice();

  let best: { txHash: string; wallet: string; ethPaidWei: string; plankAmount: string; usdValue: number; blockNumber: number } | null = null;
  let evaluated = 0;
  let skippedRoundTrip = 0;
  let skippedUnresolved = 0;

  for (const [txHash, blockNumber] of allCandidateTxs) {
    evaluated += 1;
    if (evaluated % 200 === 0) console.log(`[audit]   ...${evaluated}/${allCandidateTxs.size} evaluated, current best: ${best ? `$${best.usdValue.toFixed(2)}` : "none"}`);

    const [tx, transfers] = await Promise.all([fetchTransaction(txHash), fetchTxTokenTransfers(txHash)]);
    if (!tx || tx.status !== "ok") continue;

    const recipients = resolveFinalRecipients(transfers);
    if (recipients.size === 0) {
      skippedUnresolved += 1;
      continue;
    }
    for (const [recipient, plankAmount] of recipients) {
      if (hasRoundTripShape(transfers, recipient)) {
        skippedRoundTrip += 1;
        continue;
      }
      const { ethPaidWei, usdValue } = resolveValuePaid(transfers, recipient, ethUsd, recipients.size === 1);
      if (usdValue <= 0) continue;
      if (!best || usdValue > best.usdValue) {
        best = { txHash, wallet: recipient, ethPaidWei: ethPaidWei.toString(), plankAmount: plankAmount.toString(), usdValue, blockNumber };
      }
    }
  }

  console.log(`[audit] done. evaluated=${evaluated} skippedRoundTrip=${skippedRoundTrip} skippedUnresolved=${skippedUnresolved}`);
  if (!best) {
    console.log("[audit] no real qualifying historical buy found.");
    return;
  }
  console.log(`[audit] LARGEST REAL HISTORICAL BUY: tx=${best.txHash} wallet=${best.wallet} usd=$${best.usdValue.toFixed(2)} plank=${best.plankAmount}`);

  await postgresQuery(
    `INSERT INTO plank_koth_pre_season_record (id, tx_hash, wallet, eth_paid_wei, plank_amount, usd_value_at_buy, block_number, audited_at)
     VALUES (1, $1, $2, $3::numeric, $4::numeric, $5, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       tx_hash = EXCLUDED.tx_hash, wallet = EXCLUDED.wallet, eth_paid_wei = EXCLUDED.eth_paid_wei,
       plank_amount = EXCLUDED.plank_amount, usd_value_at_buy = EXCLUDED.usd_value_at_buy,
       block_number = EXCLUDED.block_number, audited_at = NOW()`,
    [best.txHash, best.wallet, best.ethPaidWei, best.plankAmount, best.usdValue, best.blockNumber]
  );
  console.log("[audit] written to plank_koth_pre_season_record.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[audit] fatal", error);
    process.exit(1);
  });
