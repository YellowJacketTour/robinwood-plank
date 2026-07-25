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

/**
 * Try each public RPC until the mint contract responds.
 * Prevents the mint UI from stuck on default "Closed" when one endpoint flakes.
 */
export async function getMintReadClient(): Promise<MintContractRead> {
  let lastError: unknown;

  for (const rpcUrl of ROBINHOOD_RPC_URLS) {
    try {
      const provider = new JsonRpcProvider(rpcUrl, ROBINHOOD_CHAIN_ID, {
        staticNetwork: true,
      });
      const contract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);
      await timeout(contract.salePhase(), 8_000, `RPC timeout: ${rpcUrl}`);
      return { provider, contract, rpcUrl };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("All Robinhood Chain RPCs failed.");
}
