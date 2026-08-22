/**
 * Walk each hub chain: acquire (OpenSea list / adapter sync) then harness
 * (stats in a FRESH process). Express is the hub (read-only).
 *
 *   npx tsx --env-file=.env.local scripts/run-chain-vines.ts
 *   npx tsx --env-file=.env.local scripts/run-chain-vines.ts bitcoin-mainnet solana-mainnet
 */
import { spawn } from "node:child_process";
import { CHAIN_VINES, VINE_ORDER } from "../lib/market/multichain/chain-vines";
import { runOpenSeaBulkScan } from "../lib/market/multichain/discovery/opensea-bulk-scan";
import { FOREIGN_CHAINS } from "../lib/market/multichain/trading/foreign-chain-registry";
import { runMultichainSync } from "../lib/market/multichain/sync";
import { runCoinGeckoNftStats } from "../lib/market/multichain/discovery/coingecko-nft-stats";
import { hasPostgresConfig, postgresPool } from "../lib/postgres";

const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const slugs = want.length > 0 ? want : VINE_ORDER;

function child(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("npx", ["tsx", "--env-file=.env.local", ...args], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
    });
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

async function vine(chainSlug: string): Promise<void> {
  const spec = CHAIN_VINES.find((v) => v.chainSlug === chainSlug);
  console.log(`\n======== VINE ${chainSlug} ========`);
  if (spec) console.log(JSON.stringify({ acquire: spec.acquire, harness: spec.harness, express: spec.express }));

  const foreign = FOREIGN_CHAINS.find((c) => c.chainSlug === chainSlug && c.openSeaChain);
  if (foreign?.openSeaChain) {
    const r = await runOpenSeaBulkScan({
      chainSlug: foreign.chainSlug,
      openSeaChain: foreign.openSeaChain,
      chainId: foreign.chainId,
      maxPages: chainSlug === "eth-mainnet" ? 8 : 4,
    });
    console.log("[acquire bulk]", JSON.stringify(r));
    const code = await child([
      "scripts/spoke-backfill.ts",
      "--spoke=evm-opensea-stats",
      `--chains=${chainSlug}`,
      "--minutes=3",
    ]);
    console.log("[harness stats] exit", code);
  }

  if (chainSlug === "solana-mainnet" || chainSlug === "bitcoin-mainnet") {
    const sync = await runMultichainSync({ maxCollections: 80, chainSlug });
    console.log("[harness adapter-sync]", JSON.stringify(sync));
    const cg = await runCoinGeckoNftStats(chainSlug, 20);
    console.log("[harness coingecko]", JSON.stringify(cg));
  }

  if (chainSlug === "robinhood") {
    const { updateEvmVolumeFromSeaportFills } = await import("../lib/market/multichain/store");
    const fills = await updateEvmVolumeFromSeaportFills("robinhood");
    console.log("[harness fills]", JSON.stringify(fills));
  }
}

async function main(): Promise<void> {
  const { sanitizeUnknownZeros } = await import("../lib/market/multichain/store");
  const healed = await sanitizeUnknownZeros();
  console.log("[heal] scrubbed stored zeros", JSON.stringify(healed));
  for (const slug of slugs) {
    try {
      await vine(slug);
    } catch (e) {
      console.error(`[vine] ${slug} FAILED`, e instanceof Error ? e.message : e);
    }
  }
}

main()
  .then(async () => {
    if (hasPostgresConfig()) await postgresPool().end();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    try {
      if (hasPostgresConfig()) await postgresPool().end();
    } catch {
      /* */
    }
    process.exit(1);
  });
