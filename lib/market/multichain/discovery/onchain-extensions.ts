/**
 * Real, direct on-chain reads for the advanced-standard detection surface
 * described in docs/AUDIT-onchain-data-extraction-2026-08-24.md section 1.8
 * -- ERC-4906 dynamic-metadata signaling, ERC-6551 token-bound accounts, and
 * delegate.cash's DelegateRegistry. Follows the same rpc-provider-pool +
 * ethers v6 Interface/AbiCoder pattern as onchain-contract-reads.ts: every
 * call is try/catch, a revert or unsupported method is a normal, honest
 * null/[] -- never a thrown error surfaced to the caller.
 *
 * Every contract address and function/event signature below was verified
 * against the real EIP text / canonical docs before being hardcoded (see
 * the report accompanying this file for the exact sources). None of it is
 * guessed or "plausible-looking."
 */
import { Interface, AbiCoder, ZeroHash } from "ethers";
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";

const CODER = AbiCoder.defaultAbiCoder();

// ---------------------------------------------------------------------------
// 1. ERC-4906 -- Dynamic metadata (Final EIP, eips.ethereum.org/EIPS/eip-4906)
// ---------------------------------------------------------------------------
// Interface ID verified from the EIP-4906 spec text itself: "The
// `supportsInterface` method MUST return `true` when called with
// `0x49064906`." Event signatures verified from the same spec:
//   event MetadataUpdate(uint256 _tokenId);
//   event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
const ERC4906_INTERFACE_ID = "0x49064906";

const ERC165_IFACE = new Interface([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
]);

const ERC4906_EVENTS_IFACE = new Interface([
  "event MetadataUpdate(uint256 _tokenId)",
  "event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId)",
]);

/**
 * Real ERC-165 `supportsInterface(0x49064906)` check for ERC-4906 support.
 * Returns null (not false) when the contract doesn't implement ERC-165 at
 * all (a revert on the probe call itself) -- that's a genuinely unknown
 * answer, distinct from a contract that implements ERC-165 and honestly
 * answers false.
 */
export async function hasMetadataUpdateSupport(
  chainSlug: string,
  contractAddress: string,
): Promise<boolean | null> {
  try {
    const data = ERC165_IFACE.encodeFunctionData("supportsInterface", [ERC4906_INTERFACE_ID]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [supported] = CODER.decode(["bool"], result);
    return Boolean(supported);
  } catch {
    return null;
  }
}

export type MetadataUpdateLogEntry = {
  tokenId: string | null;
  fromTokenId: string | null;
  toTokenId: string | null;
  blockNumber: number;
};

/** AUDIT lens 4 #4 (Batch F4): the largest block span one `eth_getLogs`
 * call is allowed to cover. 2,000 blocks is at or under every public
 * provider's documented range ceiling (Alchemy 2k for free tier, Infura
 * 10k, QuickNode 10k, most self-hosted nodes unbounded), so a chunk never
 * hits a "query returned more than N results / range too large" error. */
export const ERC4906_LOG_CHUNK_BLOCKS = 2_000;

/** Pure chunk planner, exported for tests: splits [fromBlock, toBlock]
 * (inclusive) into consecutive inclusive ranges of at most `chunkSize`. */
export function planBlockChunks(fromBlock: number, toBlock: number, chunkSize = ERC4906_LOG_CHUNK_BLOCKS): Array<{ fromBlock: number; toBlock: number }> {
  const chunks: Array<{ fromBlock: number; toBlock: number }> = [];
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock) return chunks;
  const size = Math.max(1, Math.floor(chunkSize));
  for (let start = fromBlock; start <= toBlock; start += size) {
    chunks.push({ fromBlock: start, toBlock: Math.min(toBlock, start + size - 1) });
  }
  return chunks;
}

/** One raw `eth_getLogs` call for both ERC-4906 topics. THROWS on an RPC
 * failure -- the caller decides whether a failure is fatal to its cursor
 * (erc4906-rescan.ts must NOT advance past a range it never scanned). */
async function fetchMetadataUpdateLogsRange(
  chainSlug: string,
  contractAddress: string,
  fromBlock: number,
  toBlock: number | "latest",
): Promise<MetadataUpdateLogEntry[]> {
  const fromBlockHex = `0x${fromBlock.toString(16)}`;
  const toBlockHex = toBlock === "latest" ? "latest" : `0x${toBlock.toString(16)}`;
  const metadataUpdateTopic = ERC4906_EVENTS_IFACE.getEvent("MetadataUpdate")!.topicHash;
  const batchMetadataUpdateTopic = ERC4906_EVENTS_IFACE.getEvent("BatchMetadataUpdate")!.topicHash;
  const { result } = await rpcCall<Array<{ topics: string[]; data: string; blockNumber: string }>>(
    chainSlug,
    "eth_getLogs",
    [
      {
        address: contractAddress,
        fromBlock: fromBlockHex,
        toBlock: toBlockHex,
        topics: [[metadataUpdateTopic, batchMetadataUpdateTopic]],
      },
    ],
  );
  if (!Array.isArray(result)) throw new Error(`eth_getLogs returned a non-array for ${contractAddress} ${fromBlockHex}..${toBlockHex}`);
  const entries: MetadataUpdateLogEntry[] = [];
  for (const log of result) {
    try {
      const blockNumber = Number(BigInt(log.blockNumber));
      const topic0 = log.topics?.[0];
      if (topic0 === metadataUpdateTopic) {
        const parsed = ERC4906_EVENTS_IFACE.decodeEventLog("MetadataUpdate", log.data, log.topics);
        entries.push({ tokenId: parsed._tokenId.toString(), fromTokenId: null, toTokenId: null, blockNumber });
      } else if (topic0 === batchMetadataUpdateTopic) {
        const parsed = ERC4906_EVENTS_IFACE.decodeEventLog("BatchMetadataUpdate", log.data, log.topics);
        entries.push({
          tokenId: null,
          fromTokenId: parsed._fromTokenId.toString(),
          toTokenId: parsed._toTokenId.toString(),
          blockNumber,
        });
      }
    } catch {
      // one malformed/undecodable log entry is skipped, not fatal to the scan
    }
  }
  return entries;
}

/**
 * Scans `eth_getLogs` for real `MetadataUpdate` and `BatchMetadataUpdate`
 * events emitted by a contract in a block range. A single-token update
 * entry has `tokenId` set and `fromTokenId`/`toTokenId` null; a batch entry
 * has the reverse. Swallows RPC failures as [] -- callers that need to
 * know whether the range was actually covered use scanMetadataUpdateLogsChunked.
 */
export async function scanMetadataUpdateLogs(
  chainSlug: string,
  contractAddress: string,
  opts: { fromBlock: number; toBlock: number | "latest" },
): Promise<MetadataUpdateLogEntry[]> {
  try {
    return await fetchMetadataUpdateLogsRange(chainSlug, contractAddress, opts.fromBlock, opts.toBlock);
  } catch {
    return [];
  }
}

export type ChunkedMetadataUpdateScan = {
  entries: MetadataUpdateLogEntry[];
  /** Highest block number PROVABLY covered (every chunk up to and
   * including it succeeded). null when the very first chunk failed. */
  scannedThrough: number | null;
  chunksAttempted: number;
  chunksSucceeded: number;
  /** Message of the failure that stopped the walk, if any. */
  error: string | null;
};

/**
 * AUDIT lens 4 #4: chunked, fail-honest scan. Walks [fromBlock, toBlock]
 * in <= `chunkSize`-block eth_getLogs calls (default 2,000) and STOPS at
 * the first RPC failure, reporting exactly how far it got so the caller's
 * durable cursor can advance only over ranges that were really scanned.
 * `maxChunks` bounds one invocation (a cold or long-idle cursor is caught
 * up across several passes rather than one unbounded burst).
 */
export async function scanMetadataUpdateLogsChunked(
  chainSlug: string,
  contractAddress: string,
  opts: { fromBlock: number; toBlock: number; chunkSize?: number; maxChunks?: number },
  deps: { fetchRange?: (fromBlock: number, toBlock: number) => Promise<MetadataUpdateLogEntry[]> } = {},
): Promise<ChunkedMetadataUpdateScan> {
  const fetchRange = deps.fetchRange ?? ((from: number, to: number) => fetchMetadataUpdateLogsRange(chainSlug, contractAddress, from, to));
  const chunks = planBlockChunks(opts.fromBlock, opts.toBlock, opts.chunkSize ?? ERC4906_LOG_CHUNK_BLOCKS)
    .slice(0, Math.max(1, opts.maxChunks ?? Number.POSITIVE_INFINITY));
  const out: ChunkedMetadataUpdateScan = { entries: [], scannedThrough: null, chunksAttempted: 0, chunksSucceeded: 0, error: null };
  for (const chunk of chunks) {
    out.chunksAttempted += 1;
    try {
      const entries = await fetchRange(chunk.fromBlock, chunk.toBlock);
      out.entries.push(...entries);
      out.scannedThrough = chunk.toBlock;
      out.chunksSucceeded += 1;
    } catch (error) {
      out.error = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. ERC-6551 -- Token-bound accounts (Final EIP, eips.ethereum.org/EIPS/eip-6551)
// ---------------------------------------------------------------------------
// Canonical Registry address and reference Account implementation address
// verified against docs.tokenbound.org's mainnet deployments page (the
// registry is deployed at the same address on every chain via CREATE2, per
// the EIP itself). account() signature verified against the EIP-6551 spec
// text: account(address implementation, bytes32 salt, uint256 chainId,
// address tokenContract, uint256 tokenId).
const ERC6551_REGISTRY_ADDRESS = "0x000000006551c19487814612e58FE06813775758";
const ERC6551_REFERENCE_IMPLEMENTATION_ADDRESS = "0x41C8f39463A868d3A88af00cd0fe7102F30E44eC";
const ERC6551_DEFAULT_SALT = ZeroHash;

const ERC6551_REGISTRY_IFACE = new Interface([
  "function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address account)",
]);

/**
 * Resolves the deterministic ERC-6551 token-bound account address for a
 * given NFT via the canonical Registry's `account()` view function. This is
 * a pure computation on-chain (CREATE2-style), so it returns a real address
 * even if that account has never actually been deployed/used -- callers
 * that need to know whether it's "real" (has code / has been created)
 * should separately check `eth_getCode` or look for `AccountCreated`.
 *
 * `chainId` is resolved from the EVM chain's own numeric id via
 * `eth_chainId` unless the caller passes it explicitly -- ERC-6551's
 * account() takes the real EVM chain id, not this app's internal
 * chainSlug string.
 */
export async function resolveTokenBoundAccount(
  chainSlug: string,
  tokenContract: string,
  tokenId: string | number,
  opts?: { implementation?: string; salt?: string; chainId?: number },
): Promise<string | null> {
  try {
    const chainId = opts?.chainId ?? (await resolveNumericChainId(chainSlug));
    if (chainId === null) return null;
    const implementation = opts?.implementation ?? ERC6551_REFERENCE_IMPLEMENTATION_ADDRESS;
    const salt = opts?.salt ?? ERC6551_DEFAULT_SALT;
    const data = ERC6551_REGISTRY_IFACE.encodeFunctionData("account", [
      implementation,
      salt,
      BigInt(chainId),
      tokenContract,
      BigInt(tokenId),
    ]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: ERC6551_REGISTRY_ADDRESS, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [account] = CODER.decode(["address"], result);
    return String(account);
  } catch {
    return null;
  }
}

async function resolveNumericChainId(chainSlug: string): Promise<number | null> {
  try {
    const { result } = await rpcCall<string>(chainSlug, "eth_chainId", []);
    if (!result) return null;
    return Number(BigInt(result));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. delegate.cash DelegateRegistry v2
// ---------------------------------------------------------------------------
// Not an EIP -- a widely-adopted, immutable, canonical-address registry.
// Address and function names verified against docs.delegate.xyz's
// contract-addresses page and IDelegateRegistry.sol reference (same
// address on every EVM chain it's deployed to).
const DELEGATE_REGISTRY_ADDRESS = "0x00000000000000447e69651d841bD8D104Bed493";

// Delegation struct per IDelegateRegistry.sol: (uint8 type_, address to,
// address from, bytes32 rights, address contract_, uint256 tokenId, uint256 amount)
const DELEGATION_TUPLE = "tuple(uint8 type_, address to, address from, bytes32 rights, address contract_, uint256 tokenId, uint256 amount)";

const DELEGATE_REGISTRY_IFACE = new Interface([
  `function getOutgoingDelegations(address from) view returns (${DELEGATION_TUPLE}[])`,
  `function getIncomingDelegations(address to) view returns (${DELEGATION_TUPLE}[])`,
]);

export type DelegateCashDelegation = {
  vault: string;
  delegate: string;
  contract: string | null;
  tokenId: string | null;
};

/**
 * Reads real delegations from delegate.cash's canonical DelegateRegistry.
 * `direction: "forVault"` calls `getOutgoingDelegations(vaultOrDelegate)`
 * (delegations a cold wallet has granted out); `"forDelegate"` calls
 * `getIncomingDelegations(vaultOrDelegate)` (delegations a hot wallet has
 * received). A `contract`/`tokenId` of null means the delegation is at a
 * broader scope (ALL or CONTRACT level) rather than a specific token.
 */
export async function resolveDelegateCashDelegations(
  chainSlug: string,
  vaultOrDelegate: string,
  direction: "forVault" | "forDelegate",
): Promise<DelegateCashDelegation[]> {
  const fn = direction === "forVault" ? "getOutgoingDelegations" : "getIncomingDelegations";
  try {
    const data = DELEGATE_REGISTRY_IFACE.encodeFunctionData(fn, [vaultOrDelegate]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: DELEGATE_REGISTRY_ADDRESS, data }, "latest"]);
    if (!result || result === "0x") return [];
    const [decoded] = DELEGATE_REGISTRY_IFACE.decodeFunctionResult(fn, result);
    const rows = decoded as Array<{ to: string; from: string; contract_: string; tokenId: bigint }>;
    return Array.from(rows).map((row) => ({
      vault: row.from,
      delegate: row.to,
      contract: row.contract_ && BigInt(row.contract_) !== 0n ? row.contract_ : null,
      tokenId: row.tokenId && row.tokenId !== 0n ? row.tokenId.toString() : null,
    }));
  } catch {
    return [];
  }
}
