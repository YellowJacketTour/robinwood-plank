import { JsonRpcProvider } from "ethers";
import { NFT_CONTRACT_ADDRESS, ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";
import { MARKET_VAULT_ADDRESS } from "@/lib/constants";

/**
 * Which token IDs the vault CURRENTLY holds — derived the same way
 * lib/market/activity.ts derives sale history: by walking the collection's
 * own Transfer log, not by trusting an off-chain list. The vault contract
 * only exposes heldTokenCount()/isTokenHeld(id) (see
 * contracts/MarketplankVault.sol), not an enumeration, so "currently held"
 * is reconstructed as (every token ever transferred IN to the vault) minus
 * (every token since transferred OUT) — a token can cycle in and out
 * (deposit, then get bought out), so both directions matter, not just "ever
 * sent to the vault."
 */

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHUNK_BLOCKS = 50_000;
const MAX_CHUNKS = 12;

type RawLog = { topics: string[]; blockNumber: string };

async function firstHealthyProvider(): Promise<JsonRpcProvider> {
  let lastError: unknown = null;
  for (const url of ROBINHOOD_RPC_URLS) {
    const provider = new JsonRpcProvider(url, ROBINHOOD_CHAIN_ID, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    try {
      await provider.getBlockNumber();
      return provider;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No healthy Robinhood RPC: ${String(lastError)}`);
}

function topicToAddress(topic: string): string {
  return "0x" + topic.slice(26);
}

let cache: { at: number; ids: string[] } | null = null;
const CACHE_MS = 30_000;

export async function getVaultHeldTokenIds(): Promise<string[]> {
  if (!MARKET_VAULT_ADDRESS) return [];
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.ids;

  const vault = MARKET_VAULT_ADDRESS.toLowerCase();
  const provider = await firstHealthyProvider();
  const latest = await provider.getBlockNumber();

  const logs: RawLog[] = [];
  let toBlock = latest;
  for (let chunk = 0; chunk < MAX_CHUNKS && toBlock > 0; chunk += 1) {
    const fromBlock = Math.max(0, toBlock - CHUNK_BLOCKS);
    const found = (await provider.send("eth_getLogs", [
      {
        address: NFT_CONTRACT_ADDRESS,
        topics: [TRANSFER_TOPIC],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      },
    ])) as RawLog[];
    logs.push(...found);
    if (fromBlock === 0) break;
    toBlock = fromBlock - 1;
  }

  // Oldest-first replay: every transfer INTO the vault adds the token,
  // every transfer OUT removes it. Whatever remains at the end is what the
  // vault holds right now.
  const held = new Set<string>();
  const sorted = logs
    .filter((l) => l.topics.length === 4)
    .sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));

  for (const log of sorted) {
    const from = topicToAddress(log.topics[1]).toLowerCase();
    const to = topicToAddress(log.topics[2]).toLowerCase();
    const tokenId = BigInt(log.topics[3]).toString();
    if (to === vault) held.add(tokenId);
    if (from === vault) held.delete(tokenId);
  }

  const ids = [...held];
  cache = { at: Date.now(), ids };
  return ids;
}
