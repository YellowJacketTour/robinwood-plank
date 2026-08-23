import { rpcCall } from "@/lib/market/multichain/discovery/evm-log-scan";

export type SequentialMintCapability = {
  /** ABI selector for the contract's authoritative minted-token boundary. */
  supplySelector: `0x${string}`;
  firstTokenId: number;
  provenance: string;
};

/**
 * Contract capabilities whose semantics have been verified from a first-party
 * contract reference. This is intentionally an evidence registry, not a guess
 * that every function named `totalMinted` implies contiguous token ids.
 * Adding another collection requires proving both the boundary function and
 * the first/contiguous token-id rule.
 */
const SEQUENTIAL_MINT_CAPABILITIES: Record<string, SequentialMintCapability> = {
  // MUGS by 9mm Pro: https://mugs.9mm.pro/llms-full.txt
  // The publisher documents totalMinted() and sequential ids starting at 1.
  "robinhood:0xab75f3d72509cd3b3a386a03de2b82854f0060e5": {
    supplySelector: "0xa2309ff8",
    firstTokenId: 1,
    provenance: "mugs-first-party-total-minted",
  },
};

export function sequentialMintCapability(
  chainSlug: string,
  contractAddress: string
): SequentialMintCapability | null {
  return SEQUENTIAL_MINT_CAPABILITIES[`${chainSlug}:${contractAddress.toLowerCase()}`] ?? null;
}

export async function readSequentialMintBoundary(input: {
  chainSlug: string;
  contractAddress: string;
  rpcUrls: string[];
}): Promise<{ firstTokenId: number; lastTokenId: number; expectedCount: number; provenance: string } | null> {
  const capability = sequentialMintCapability(input.chainSlug, input.contractAddress);
  if (!capability) return null;
  let lastError: unknown;
  for (const rpcUrl of input.rpcUrls) {
    try {
      const raw = await rpcCall<string>(rpcUrl, "eth_call", [
        { to: input.contractAddress, data: capability.supplySelector },
        "latest",
      ]);
      const value = BigInt(raw);
      if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`unsafe sequential mint boundary ${value}`);
      }
      const expectedCount = Number(value);
      return {
        firstTokenId: capability.firstTokenId,
        lastTokenId: expectedCount === 0 ? capability.firstTokenId - 1 : capability.firstTokenId + expectedCount - 1,
        expectedCount,
        provenance: capability.provenance,
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}
