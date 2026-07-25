import { Contract, JsonRpcProvider, type Provider } from "ethers";
import {
  NFT_ABI,
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URLS,
} from "@/lib/mint-contract";

export type MintContractRead = {
  provider: Provider;
  contract: Contract;
  rpcUrl: string;
};

type CacheEntry = {
  client: MintContractRead;
  expiresAt: number;
};

let cached: CacheEntry | null = null;
/** Keep a healthy RPC warm; re-probe only after this window. */
const CACHE_MS = 90_000;
/** Skip health-check RPC when last success was this recent. */
const HEALTH_SKIP_MS = 20_000;
let lastHealthOkAt = 0;

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function makeProvider(rpcUrl: string): JsonRpcProvider {
  // batchMaxCount: 1 avoids 413 Payload Too Large on proxies that reject batch eth_call
  return new JsonRpcProvider(rpcUrl, ROBINHOOD_CHAIN_ID, {
    staticNetwork: true,
    batchMaxCount: 1,
    batchStallTime: 0,
  });
}

async function probe(rpcUrl: string): Promise<MintContractRead> {
  const provider = makeProvider(rpcUrl);
  const contract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);
  // Two independent calls exercises non-batch path and confirms contract ABI
  const phase = await timeout(contract.salePhase(), 8_000, `RPC timeout: ${rpcUrl}`);
  const supply = await timeout(contract.totalSupply(), 8_000, `RPC timeout: ${rpcUrl}`);
  void phase;
  void supply;
  return { provider, contract, rpcUrl };
}

/**
 * Working read client for the mint contract.
 * Caches a healthy RPC and avoids re-probing on every gallery/mint tick.
 */
export async function getMintReadClient(force = false): Promise<MintContractRead> {
  if (!force && cached && cached.expiresAt > Date.now()) {
    // Trust recent successes — gallery hydrates hundreds of calls on this client
    if (Date.now() - lastHealthOkAt < HEALTH_SKIP_MS) {
      return cached.client;
    }
    try {
      await timeout(cached.client.contract.salePhase(), 5_000, "cached RPC dead");
      lastHealthOkAt = Date.now();
      return cached.client;
    } catch {
      cached = null;
    }
  }

  let lastError: unknown;
  for (const rpcUrl of ROBINHOOD_RPC_URLS) {
    try {
      const client = await probe(rpcUrl);
      cached = { client, expiresAt: Date.now() + CACHE_MS };
      lastHealthOkAt = Date.now();
      return client;
    } catch (error) {
      lastError = error;
    }
  }

  cached = null;
  throw lastError instanceof Error
    ? lastError
    : new Error("All Robinhood Chain RPCs failed.");
}

export function clearMintReadClientCache() {
  cached = null;
  lastHealthOkAt = 0;
}

/** Mark current RPC as healthy after a successful contract call. */
export function touchMintReadClient() {
  if (cached) {
    lastHealthOkAt = Date.now();
    cached.expiresAt = Date.now() + CACHE_MS;
  }
}
