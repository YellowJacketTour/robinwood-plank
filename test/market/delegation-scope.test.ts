import assert from "node:assert/strict";
import test from "node:test";
import {
  DELEGATION_TYPES,
  delegationCoversToken,
  decodeDelegationRows,
  type DelegateCashDelegation,
} from "@/lib/market/multichain/discovery/onchain-extensions";

/**
 * An NFT can be fully committed elsewhere while sitting in its owner's wallet.
 * delegate.cash is the main way that happens, and it is invisible to any
 * pipeline that only reads Transfer events.
 *
 * These tests cover the two ways that check goes wrong SILENTLY.
 */

const COLLECTION = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";

function row(over: Partial<DelegateCashDelegation>): DelegateCashDelegation {
  return {
    vault: "0x2222222222222222222222222222222222222222",
    delegate: "0x1111111111111111111111111111111111111111",
    scope: "ERC721",
    rights: "0x" + "00".repeat(32),
    contract: COLLECTION,
    tokenId: "7",
    ...over,
  };
}

test("the enum order is the contract's, and index maps to the right name", () => {
  // The uint8 on the wire indexes into this list. Reordering it silently
  // relabels every delegation -- CONTRACT scope would read as ERC721 and a
  // whole-collection commitment would be reported as a single token.
  assert.deepEqual(
    [...DELEGATION_TYPES],
    ["NONE", "ALL", "CONTRACT", "ERC721", "ERC20", "ERC1155"],
    "IDelegateRegistry.sol's DelegationType, verbatim",
  );
  assert.equal(DELEGATION_TYPES[3], "ERC721", "type_ == 3 is the per-token NFT scope");
});

test("REGRESSION: a per-token delegation of TOKEN #0 is not mistaken for collection-wide", () => {
  // The bug this replaced inferred scope from `tokenId != 0`, so a real
  // ERC721 delegation of token 0 -- the first mint of most collections --
  // decoded as tokenId null and read as a whole-collection grant.
  const zero = row({ scope: "ERC721", tokenId: "0" });
  assert.ok(delegationCoversToken(zero, COLLECTION, "0"), "token 0 really is delegated");
  assert.ok(
    !delegationCoversToken(zero, COLLECTION, "1"),
    "and it must NOT leak into other tokens the way a collection-wide grant would",
  );
});

test("THE FALSE NEGATIVE: a wallet-wide ALL delegation covers a token with no ERC721 row", () => {
  // Most real delegations in the wild are DelegateAll. Checking only for
  // ERC721-type rows finds nothing and reports a fully-committed token as
  // uncommitted -- the single most likely way this feature ships broken.
  const all = row({ scope: "ALL", contract: null, tokenId: null });
  assert.ok(delegationCoversToken(all, COLLECTION, "12345"), "ALL covers every token");
  assert.ok(delegationCoversToken(all, OTHER, "1"), "including in other collections");
});

test("CONTRACT scope covers every token in ITS collection and no others", () => {
  const c = row({ scope: "CONTRACT", tokenId: null });
  assert.ok(delegationCoversToken(c, COLLECTION, "999"));
  assert.ok(!delegationCoversToken(c, OTHER, "999"), "must not spill into another collection");
});

test("fungible and NONE scopes are never an NFT commitment", () => {
  assert.ok(!delegationCoversToken(row({ scope: "ERC20", tokenId: null }), COLLECTION, "1"));
  assert.ok(!delegationCoversToken(row({ scope: "NONE", tokenId: null }), COLLECTION, "1"));
});

test("a per-token row for a DIFFERENT token does not cover this one", () => {
  assert.ok(!delegationCoversToken(row({ tokenId: "7" }), COLLECTION, "8"));
});

test("scope is compared case-insensitively on the address", () => {
  // Checksummed vs lowercase addresses are the same contract. A case-sensitive
  // compare would report a real delegation as absent.
  const c = row({ scope: "CONTRACT", contract: COLLECTION.toUpperCase().replace("0X", "0x"), tokenId: null });
  assert.ok(delegationCoversToken(c, COLLECTION.toLowerCase(), "1"));
});

/**
 * The decode path, where the token-#0 bug actually lived.
 *
 * The predicate tests above all passed while the decode was still wrong: they
 * exercised delegationCoversToken with hand-built rows, so they mirrored my
 * assumptions instead of testing the code. A mutation reverting the decode was
 * NOT caught until these were added.
 */
test("DECODE: an ERC721 row for token #0 keeps its token id", () => {
  const rows = decodeDelegationRows([
    {
      type_: 3n, // ERC721
      to: "0x1111111111111111111111111111111111111111",
      from: "0x2222222222222222222222222222222222222222",
      rights: "0x" + "00".repeat(32),
      contract_: COLLECTION,
      tokenId: 0n,
      amount: 0n,
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, "ERC721");
  assert.equal(rows[0].tokenId, "0", "token #0 must survive decoding as '0', never null");
  assert.ok(delegationCoversToken(rows[0], COLLECTION, "0"));
  assert.ok(!delegationCoversToken(rows[0], COLLECTION, "1"), "and must not read as collection-wide");
});

test("DECODE: at ALL/CONTRACT scope the zero-filled tokenId is not reported as token 0", () => {
  // The mirror-image error: those fields are padding, so surfacing "token 0"
  // would invent a claim the registry never made.
  for (const [type_, scope] of [[1n, "ALL"], [2n, "CONTRACT"]] as const) {
    const [r] = decodeDelegationRows([
      {
        type_,
        to: "0x1111111111111111111111111111111111111111",
        from: "0x2222222222222222222222222222222222222222",
        rights: "0x" + "00".repeat(32),
        contract_: COLLECTION,
        tokenId: 0n,
        amount: 0n,
      },
    ]);
    assert.equal(r.scope, scope);
    assert.equal(r.tokenId, null, `${scope} scope must not claim a token id`);
  }
});
