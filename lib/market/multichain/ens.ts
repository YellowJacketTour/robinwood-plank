/**
 * Real ENS reverse resolution -- "whenever publicly known," never
 * fabricated. Verified live 2026-08-18: ethers' provider.lookupAddress
 * against a public Ethereum mainnet RPC correctly resolved a known
 * address to "vitalik.eth". ENS itself lives only on Ethereum mainnet by
 * protocol, but a name resolves for a wallet regardless of which chain
 * that wallet is a collection's creator/owner ON -- this is a pure
 * address lookup, not scoped to the collection's own chain.
 */
import { JsonRpcProvider } from "ethers";

const ENS_MAINNET_RPC = "https://ethereum-rpc.publicnode.com";
let provider: JsonRpcProvider | null = null;

function getProvider(): JsonRpcProvider {
  if (!provider) provider = new JsonRpcProvider(ENS_MAINNET_RPC);
  return provider;
}

/** Null on no ENS name, an unreachable RPC, or any resolution error -- never throws, never guesses. */
export async function resolveEnsName(address: string): Promise<string | null> {
  try {
    return await getProvider().lookupAddress(address);
  } catch {
    return null;
  }
}
