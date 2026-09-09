import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  collectionKey,
  normalizeContractAddress,
  sameCollection,
} from "../../lib/market/multichain/collection-key";

/**
 * One collection identity, for every chain.
 *
 * This codebase has already paid for this bug once. store.ts's own header,
 * dated 2026-08-20:
 *
 *   "every write path here unconditionally lowercased contractAddress...
 *    WRONG for Solana pubkeys and Bitcoin Ordinals slugs -- Solana's base58
 *    addresses are case-sensitive, so lowercasing one turns it into a
 *    different, almost always invalid pubkey. Confirmed live: every
 *    'solana-mainnet' row registered before this fix had a corrupted,
 *    unresolvable address (getAsset returning a real 'Pubkey Validation
 *    Err') -- not a rare edge case, effectively all of them."
 *
 * The fix landed in a PRIVATE function, so the rule was re-derived elsewhere:
 * two byte-identical private copies of a second, shape-based rule
 * (archival-ledger.ts, collection-demand.ts) and ~25 inline
 * `${chainSlug}:${contract.toLowerCase()}` literals that unconditionally
 * lowercase -- each one reintroducing the exact bug that was already fixed.
 *
 * A corrupted key does not throw. It produces a cache miss, an empty lookup,
 * a row that never joins: work that silently accomplishes nothing while every
 * log line stays green.
 */

const SRC = readFileSync("lib/market/multichain/collection-key.ts", "utf8").replace(/\r\n/g, "\n");
const STORE = readFileSync("lib/market/multichain/store.ts", "utf8").replace(/\r\n/g, "\n");

// A real Solana pubkey shape: base58, mixed case, case IS identity.
const SOLANA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
// A checksummed EVM address: case is decoration, not identity.
const EVM_CHECKSUMMED = "0x5Af0D9827E0c53E4799BB226655A1de152A425a5";

test("a Solana pubkey keeps its exact case", () => {
  // The 2026-08-20 bug, as a value. Lowercasing this produces a different,
  // invalid pubkey -- and every Solana row registered before the store fix
  // had exactly that.
  assert.equal(normalizeContractAddress("solana-mainnet", SOLANA), SOLANA);
  assert.ok(
    collectionKey("solana-mainnet", SOLANA).endsWith(SOLANA),
    "the composite key must carry the pubkey verbatim"
  );
});

test("a Bitcoin inscription id keeps its exact case", () => {
  const inscription = "AbCdEf1234567890i0";
  assert.equal(normalizeContractAddress("bitcoin-mainnet", inscription), inscription);
});

test("an EVM address is lowercased so a checksummed input matches a stored row", () => {
  // The other half of the rule. If checksummed input were preserved, a
  // lookup would miss the lowercase row the catalog actually holds.
  assert.equal(
    normalizeContractAddress("eth-mainnet", EVM_CHECKSUMMED),
    EVM_CHECKSUMMED.toLowerCase()
  );
  assert.equal(
    collectionKey("eth-mainnet", EVM_CHECKSUMMED),
    `eth-mainnet:${EVM_CHECKSUMMED.toLowerCase()}`
  );
});

test("the CHAIN decides, never the shape of the string", () => {
  // The two private copies in archival-ledger.ts / collection-demand.ts key
  // off `/^0x[0-9a-f]{40}$/`, i.e. the shape. That happens to be safe today
  // and disagrees with the store on any EVM address that is not exactly 40
  // hex. Two rules that agree by luck are one refactor from disagreeing.
  const notFortyHex = "0xABC";
  assert.equal(
    normalizeContractAddress("eth-mainnet", notFortyHex),
    "0xabc",
    "an EVM chain lowercases regardless of length"
  );
  // And a base58 string that happens to look hex-ish on a non-EVM chain is
  // still preserved, because the chain -- not the string -- decides.
  assert.equal(normalizeContractAddress("solana-mainnet", "0xABC"), "0xABC");
});

test("this module agrees with store.ts exactly", () => {
  // If these two ever diverge, keys built here silently miss rows written
  // there. Pinned to the store's real implementation rather than trusted.
  const at = STORE.indexOf("function normalizeContractAddress");
  assert.ok(at > 0, "the store's normalizer must exist");
  const body = STORE.slice(at, STORE.indexOf("\n}", at));
  assert.match(
    body,
    /isNonEvmChainSlug\(chainSlug\) \? contractAddress : contractAddress\.toLowerCase\(\)/,
    "the store's rule must be chain-based"
  );
  assert.match(
    SRC,
    /isNonEvmChainSlug\(chainSlug\) \? contractAddress : contractAddress\.toLowerCase\(\)/,
    "and this module must implement the identical rule"
  );
});

test("sameCollection compares under each side's own chain rule", () => {
  // Comparing raw strings makes a checksummed address miss a lowercase row.
  // Comparing lowercased strings makes two different Solana mints look
  // identical. Both are avoided by normalising each side under its own chain.
  assert.ok(
    sameCollection(
      { chainSlug: "eth-mainnet", contractAddress: EVM_CHECKSUMMED },
      { chainSlug: "eth-mainnet", contractAddress: EVM_CHECKSUMMED.toLowerCase() }
    ),
    "checksummed and lowercase are the same EVM collection"
  );
  assert.ok(
    !sameCollection(
      { chainSlug: "solana-mainnet", contractAddress: SOLANA },
      { chainSlug: "solana-mainnet", contractAddress: SOLANA.toLowerCase() }
    ),
    "a lowercased pubkey is a DIFFERENT collection, not the same one"
  );
});

test("different chains are never the same collection", () => {
  assert.ok(
    !sameCollection(
      { chainSlug: "eth-mainnet", contractAddress: EVM_CHECKSUMMED },
      { chainSlug: "base-mainnet", contractAddress: EVM_CHECKSUMMED }
    ),
    "the same contract address on two chains is two collections"
  );
});

test("the composite key round-trips through its own normaliser", () => {
  // Idempotence: normalising an already-normalised key must not change it,
  // or a value would drift every time it passed through the pipeline.
  for (const [chain, addr] of [
    ["eth-mainnet", EVM_CHECKSUMMED],
    ["solana-mainnet", SOLANA],
    ["bitcoin-mainnet", "AbCdi0"],
  ] as const) {
    const once = normalizeContractAddress(chain, addr);
    assert.equal(normalizeContractAddress(chain, once), once, `${chain} must be idempotent`);
  }
});
