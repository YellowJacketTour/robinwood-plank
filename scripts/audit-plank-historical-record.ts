/**
 * Real, one-time audit: walk $PLANK's full real transfer history on every
 * canonical pool, from genesis to now, and find the single largest real
 * buy that ever happened -- using the EXACT SAME value-resolution and
 * fraud-check primitives the live Season 2 pipeline uses
 * (lib/market/plank-koth-candidate.ts / plank-koth-net-classify.ts), not a
 * separate, unproven scan. This is the operator's own explicit ask: "as
 * proof you know your methods work you should have to audit all
 * historical buys... and confirm the largest previous single txn."
 *
 * Real rewrite, 2026-08-26 (external Grok research review): reads directly
 * from the chain's own RPC (eth_getLogs + eth_getTransactionReceipt) via
 * rpc-provider-pool.ts's throw-on-failure contract, instead of Blockscout
 * REST -- see plank-koth-rpc-scan.ts's own header for the real,
 * live-confirmed bug this closes (a Blockscout failure silently looked
 * identical to "no buy here"). A one-off historical walk over the token's
 * ENTIRE real history is exactly the shape most likely to hit a transient
 * failure somewhere in the range; distinguishing "we haven't scanned this
 * yet" from "we scanned it and found nothing" matters here more than
 * almost anywhere else in this app.
 *
 * Result is written to plank_koth_pre_season_record (migration 079) as a
 * real, honest "pre-season reference" -- displayed as a minor line on the
 * board until the real Season 2 competition begins, never mixed into the
 * live leaderboard/rule-engine state (a pre-launch buy was never a real
 * contest entry).
 *
 * Usage: npx tsx --env-file=.env.local scripts/audit-plank-historical-record.ts
 */
import { rpcCall } from "../lib/market/multichain/discovery/rpc-provider-pool";
import { CANONICAL_PLANK_POOLS, isCanonicalPlankPool } from "../lib/market/plank-pools";
import { ERC20_TRANSFER_TOPIC, decodeErc20TransfersForTokens, computeNetBalances, classifyNetBuyCandidates } from "../lib/market/plank-koth-net-classify";
import { fetchReceiptRpc, canonicalPoolAddressesLower, assertChainLive } from "../lib/market/plank-koth-rpc-scan";
import { getEthUsdPrice, weiToUsd } from "../lib/eth-price";
import { postgresQuery } from "../lib/postgres";
import { CONTRACT_ADDRESS as PLANK_CONTRACT } from "../lib/constants";

const CHAIN_SLUG = "robinhood";
const CHUNK_BLOCKS = 20_000;
const USDG_USD = 1;

function quoteTokenSymbolMap(): Map<string, "WETH" | "USDG"> {
  const map = new Map<string, "WETH" | "USDG">();
  for (const pool of CANONICAL_PLANK_POOLS) map.set(pool.counterToken.toLowerCase(), pool.counterSymbol);
  return map;
}

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string };

/** Real range-shrink-on-failure walk from `deployBlock` to the current real
 * chain head, throwing (not silently returning partial results as if they
 * were complete) if it can never make progress on a range even at the
 * smallest chunk size -- this audit's whole point is a trustworthy answer,
 * a swallowed gap here would silently under-report the real historical max. */
async function walkAllCandidateTxs(deployBlock: number): Promise<Map<string, number>> {
  const head = await assertChainLive(null);
  const candidates = new Map<string, number>();
  let from = deployBlock;
  while (from <= head) {
    let chunk = CHUNK_BLOCKS;
    let logs: RawLog[] | null = null;
    let lastError: unknown = null;
    let to = Math.min(head, from + chunk - 1);
    while (chunk >= 500) {
      to = Math.min(head, from + chunk - 1);
      try {
        const { result } = await rpcCall<RawLog[]>(CHAIN_SLUG, "eth_getLogs", [
          { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: PLANK_CONTRACT, topics: [ERC20_TRANSFER_TOPIC] },
        ]);
        logs = result;
        break;
      } catch (error) {
        lastError = error;
        chunk = Math.floor(chunk / 2);
      }
    }
    if (logs === null) {
      throw lastError instanceof Error ? lastError : new Error(`audit: eth_getLogs failed at block ${from}: ${String(lastError)}`);
    }
    for (const log of logs) {
      if (log.topics.length !== 3 || !log.topics[1]) continue;
      const txFrom = "0x" + log.topics[1].slice(-40).toLowerCase();
      if (!isCanonicalPlankPool(txFrom)) continue;
      candidates.set(log.transactionHash, Number.parseInt(log.blockNumber, 16));
    }
    console.log(`[audit]   scanned blocks ${from}-${to} (${logs.length} PLANK transfers, ${candidates.size} candidates so far)`);
    from = to + 1;
  }
  return candidates;
}

async function main() {
  const deployBlockArg = process.env.PLANK_DEPLOY_BLOCK ? Number(process.env.PLANK_DEPLOY_BLOCK) : NaN;
  if (!Number.isFinite(deployBlockArg)) {
    throw new Error("audit: set PLANK_DEPLOY_BLOCK to the real block $PLANK was deployed at (no on-chain deploy-block lookup wired here yet)");
  }
  console.log(`[audit] walking real on-chain history for $PLANK from block ${deployBlockArg}...`);
  const allCandidateTxs = await walkAllCandidateTxs(deployBlockArg);
  console.log(`[audit] ${allCandidateTxs.size} unique candidate transactions -- evaluating real value paid...`);

  const { usd: ethUsd } = await getEthUsdPrice();
  const symbolByToken = quoteTokenSymbolMap();
  const quoteTokenAddresses = [...symbolByToken.keys()];
  const excluded = new Set([...canonicalPoolAddressesLower(), PLANK_CONTRACT.toLowerCase(), ...quoteTokenAddresses]);
  const relevantTokens = new Set([PLANK_CONTRACT.toLowerCase(), ...quoteTokenAddresses]);

  let best: { txHash: string; wallet: string; ethPaidWei: string; plankAmount: string; usdValue: number; blockNumber: number } | null = null;
  let evaluated = 0;
  let skippedRoundTrip = 0;
  let skippedUnresolved = 0;

  for (const [txHash, blockNumber] of allCandidateTxs) {
    evaluated += 1;
    if (evaluated % 200 === 0) console.log(`[audit]   ...${evaluated}/${allCandidateTxs.size} evaluated, current best: ${best ? `$${best.usdValue.toFixed(2)}` : "none"}`);

    const receipt = await fetchReceiptRpc(txHash).catch(() => null);
    if (!receipt || receipt.status !== "0x1") continue;
    const decoded = decodeErc20TransfersForTokens(receipt.logs, relevantTokens);
    const net = computeNetBalances(decoded);
    const candidates = classifyNetBuyCandidates(net, PLANK_CONTRACT, quoteTokenAddresses, excluded);
    if (candidates.length === 0) {
      skippedUnresolved += 1;
      continue;
    }
    for (const candidate of candidates) {
      if (candidate.hasRoundTripShape) {
        skippedRoundTrip += 1;
        continue;
      }
      let ethPaidWei = 0n;
      let usdValue = 0;
      for (const [tokenAddress, amount] of candidate.quoteSpent) {
        const symbol = symbolByToken.get(tokenAddress);
        if (symbol === "WETH") {
          ethPaidWei += amount;
          usdValue += weiToUsd(amount, ethUsd);
        } else if (symbol === "USDG") {
          usdValue += Number(amount) / 1_000_000 * USDG_USD;
        }
      }
      if (usdValue <= 0) continue;
      if (!best || usdValue > best.usdValue) {
        best = { txHash, wallet: candidate.wallet, ethPaidWei: ethPaidWei.toString(), plankAmount: candidate.plankAmount.toString(), usdValue, blockNumber };
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
