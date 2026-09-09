import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  TRANSFER_TOPIC,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_BATCH_TOPIC,
  CONSECUTIVE_TRANSFER_TOPIC,
  NFT_OWNERSHIP_TOPICS,
} from "@/lib/market/multichain/discovery/evm-log-scan";
import { expandConsecutiveRange } from "@/lib/market/multichain/discovery/hypersync-evm-scan";

/**
 * ERC-2309 is the hole that cannot be found by looking at what discovery
 * returns, because a collection that batch-mints and never trades emits NONE
 * of the three topics discovery used to watch. It is absent from the results
 * AND absent from the errors -- the exact "miss indistinguishable from
 * nothing happened" shape that has bitten this codebase repeatedly.
 */

const SCAN = readFileSync("lib/market/multichain/discovery/evm-log-scan.ts", "utf8").replace(/\r\n/g, "\n");
const HYPER = readFileSync("lib/market/multichain/discovery/hypersync-evm-scan.ts", "utf8").replace(/\r\n/g, "\n");

test("every ownership topic is the real keccak of its signature", () => {
  // Recomputed here independently. A copied constant that is subtly wrong
  // silently scans for an event that no contract emits -- and returns zero
  // results forever, which looks exactly like a quiet chain.
  const expect = (sig: string) => keccak256(toUtf8Bytes(sig));
  assert.equal(TRANSFER_TOPIC, expect("Transfer(address,address,uint256)"));
  assert.equal(TRANSFER_SINGLE_TOPIC, expect("TransferSingle(address,address,address,uint256,uint256)"));
  assert.equal(TRANSFER_BATCH_TOPIC, expect("TransferBatch(address,address,address,uint256[],uint256[])"));
  assert.equal(
    CONSECUTIVE_TRANSFER_TOPIC,
    expect("ConsecutiveTransfer(uint256,uint256,address,address)"),
  );
});

test("ERC-2309 is actually in the set discovery scans for", () => {
  assert.ok(
    (NFT_OWNERSHIP_TOPICS as readonly string[]).includes(CONSECUTIVE_TRANSFER_TOPIC),
    "a constant that exists but is never scanned for closes nothing",
  );
  assert.equal(new Set(NFT_OWNERSHIP_TOPICS).size, 4, "four distinct topics");
});

test("NO scan anywhere in the tree still asks for only the old three topics", () => {
  // Scan the WHOLE tree, not a hardcoded file list. When this test named only
  // two files it passed while three other live scan lanes -- including an
  // entire chain's discovery (robinhood-chain-scan) and the keyless hunter
  // driver -- still requested the old set. A test that only looks where the
  // author already looked cannot find the case the author missed.
  // `git grep -l` exits 1 when there are no matches, which is the PASSING
  // case here -- so a bare execFileSync throws exactly when the code is
  // correct. Treat exit 1 as "no hits", and let any other failure surface.
  let hits = "";
  try {
    hits = execFileSync(
      "git",
      ["grep", "-l", "TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]]", "--", "lib", "app", "scripts", "packages"],
      { encoding: "utf8" },
    ).trim();
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    if (e.status !== 1) throw error;
    hits = "";
  }
  assert.equal(hits, "", `these scans still request the old three-topic set:
${hits}`);
});

test("the accept-check cannot drop a topic the query asked for", () => {
  // The subtle half of this bug class: widening the QUERY without widening
  // the filter means the logs arrive and are then thrown away -- more
  // expensive than before and exactly as incomplete.
  assert.ok(
    !/topic0 !== TRANSFER_TOPIC && topic0 !== TRANSFER_SINGLE_TOPIC && topic0 !== TRANSFER_BATCH_TOPIC/.test(HYPER),
    "an accept-check still hardcodes the old three topics",
  );
});

test("a real ERC-2309 range expands inclusively", () => {
  const ids = expandConsecutiveRange("0x" + (0).toString(16).padStart(64, "0"), "0x" + (4).toString(16).padStart(64, "0"));
  assert.deepEqual(ids, ["0", "1", "2", "3", "4"], "both ends inclusive per the spec");
});

test("THE GUARD FIRES: an over-wide range expands to nothing, not to death", () => {
  // uint256 max. A naive expander allocates until the process dies -- a real
  // DoS surface on a scanner that reads every log on chain by design.
  const max = "0x" + "f".repeat(64);
  const zero = "0x" + "0".repeat(64);
  const ids = expandConsecutiveRange(zero, max);
  assert.equal(ids.length, 0, "the cap must refuse, not truncate");

  // And prove the boundary is where it claims to be, so the cap cannot be
  // quietly raised to something unsafe without this failing.
  const hex = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  assert.equal(expandConsecutiveRange(hex(1n), hex(100_000n)).length, 100_000, "exactly at the cap is allowed");
  assert.equal(expandConsecutiveRange(hex(1n), hex(100_001n)).length, 0, "one past the cap is refused");
});

test("THE GUARD FIRES: an inverted or malformed range is refused", () => {
  const hex = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  assert.equal(expandConsecutiveRange(hex(9n), hex(4n)).length, 0, "to < from is not a claim we can support");
  assert.equal(expandConsecutiveRange(null, hex(4n)).length, 0);
  assert.equal(expandConsecutiveRange("not-hex", hex(4n)).length, 0, "must not throw on garbage");
});

test("refusing to expand still leaves the collection discoverable", () => {
  // The design point worth locking down: an over-wide range must not make the
  // COLLECTION invisible too. Discovery tallies by log address before any
  // token-id extraction, so the collection is registered either way.
  //
  // Bound this on the CALL SITE, not the first textual occurrence: indexOf
  // finds the helper's own definition near the top of the file, which is
  // above the tally and made this assertion fail while the code was correct.
  // That is the same fixed-offset mistake this session has now made five
  // times -- anchor on real structure, never on position.
  // Check EVERY tallying scan, pairing each tally with the expansion that
  // follows it in the SAME loop -- not the first occurrence of each in the
  // file. The first expandConsecutiveRange call belongs to the address-scoped
  // enumerator, which has no tally at all, so a whole-file indexOf compared
  // unrelated lines and failed while the code was correct.
  const tallies = [...HYPER.matchAll(/tally\.set\(key, \(tally\.get\(key\) \?\? 0\) \+ 1\);/g)].map((m) => m.index!);
  const expansions = [...HYPER.matchAll(/for \(const id of expandConsecutiveRange\(/g)].map((m) => m.index!);
  assert.ok(tallies.length >= 3, `expected the tallying discovery scans (saw ${tallies.length})`);
  for (const t of tallies) {
    const next = expansions.find((e) => e > t);
    assert.ok(
      next !== undefined,
      "a tallying scan has no ERC-2309 expansion after it -- batch-minted tokens would never enumerate",
    );
  }
});