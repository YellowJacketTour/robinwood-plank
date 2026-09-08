/**
 * A BRC-20 tick transfer may never become a Marketplank collection.
 *
 * This is the mall bug in tapscript form. Bitcoin's tape is mostly fungible
 * token rows: the OrdinalsWallet catalog is ~425,000 entries of which ~1,837
 * are real collections, the rest BRC-20. If the hose promotes a `tick` to a
 * collection, Bitcoin's collection count inflates by two orders of magnitude
 * with objects that have no supply, no traits, and no floor -- and every
 * downstream number is wrong in a way no later fix repairs.
 *
 * The real body below came off mainnet block 966018, ingested live by this
 * package on 2026-09-08.
 *
 * THE STRUCTURAL ARGUMENT, checked here rather than trusted:
 *
 *   1. the envelope parser never reads the body's JSON, so it cannot know or
 *      care that a payload says "brc-20"
 *   2. the adapter mints `kind: "inscription"` only -- there is no collection
 *      branch to reach
 *   3. a COLLECTION is a cluster, and clusters come from hard edges (parent,
 *      same-reveal, collection field), never from a single inscription
 */
import { test } from "node:test";
import { eq, ok, sha256Stub } from "./_expect.ts";
import { parseEnvelopes } from "../src/hose/adapters/envelope.ts";
import { deriveHardEdges } from "../src/cluster/derive.ts";
import type { ChainEvent } from "../src/shared/types.ts";

const sha = sha256Stub();
const TXID = "457d87c962773846dbcc7dbaa90685f5ab70d654cb3774ef461efe3edd578a60";

/** The exact payload block 966018 carried. */
const REAL_BRC20_BODY = '{"p":"brc-20","op":"transfer","amt":"21985295662","tick":"sats"}';

function envelopeFor(body: string, contentType = "text/plain;charset=utf-8"): Uint8Array {
  const ascii = (s: string) => [...new TextEncoder().encode(s)];
  const push = (b: number[]) => {
    if (b.length < 0x4c) return [b.length, ...b];
    if (b.length <= 0xff) return [0x4c, b.length, ...b];
    return [0x4d, b.length & 0xff, (b.length >> 8) & 0xff, ...b];
  };
  return new Uint8Array([
    0x00, 0x63,
    ...push(ascii("ord")),
    0x51, ...push(ascii(contentType)),
    0x00, ...push(ascii(body)),
    0x68,
  ]);
}

test("the real block-966018 BRC-20 body parses as ONE inscription and nothing more", () => {
  const found = parseEnvelopes(
    envelopeFor(REAL_BRC20_BODY),
    { revealTxid: TXID, inputIndex: 0 },
    sha,
  );

  eq(found.length, 1);
  eq(found[0]!.id, `${TXID}i0`);
  eq(found[0]!.contentType, "text/plain;charset=utf-8");
  eq(found[0]!.parent, null, "a tick transfer declares no parent, so it joins nothing");

  // The parser must not have opinions about payload semantics. If it ever
  // grows a `if (body.p === "brc-20")` branch, that is the moment a tick can
  // start being treated as a different KIND of thing.
  const keys = Object.keys(found[0]!);
  ok(!keys.some((k) => /brc|tick|protocol|fungible/i.test(k)),
    `the parser leaked payload semantics into its output: ${keys.join(",")}`);
});

test("a lone BRC-20 inscription produces NO hard edge, so it cannot form a collection", () => {
  const ev: ChainEvent = {
    chain: "bitcoin",
    blockHash: "0x" + "bb".repeat(32) as `0x${string}`,
    height: 966_018,
    loc: 0,
    txHash: `0x${TXID}` as `0x${string}`,
    kind: "envelope",
    contractOrProgram: "ord",
    tokenOrInscription: `${TXID}i0`,
    fromAddr: "",
    toAddr: "",
    raw: { parent: null, contentType: "text/plain;charset=utf-8" },
  };

  const edges = deriveHardEdges({ chain: "bitcoin", events: [ev] });
  eq(edges.length, 0, "one inscription in one reveal announces nothing about membership");
});

test("two unrelated tick transfers in DIFFERENT reveals stay unrelated", () => {
  // The inflation scenario: a block full of BRC-20 transfers. If these were
  // ever grouped, Bitcoin's collection count would balloon with fungible rows.
  const mk = (txid: string, loc: number): ChainEvent => ({
    chain: "bitcoin",
    blockHash: "0x" + "bb".repeat(32) as `0x${string}`,
    height: 966_018,
    loc,
    txHash: `0x${txid}` as `0x${string}`,
    kind: "envelope",
    contractOrProgram: "ord",
    tokenOrInscription: `${txid}i0`,
    fromAddr: "",
    toAddr: "",
    raw: { parent: null },
  });

  const edges = deriveHardEdges({
    chain: "bitcoin",
    events: [mk("a".repeat(64), 0), mk("b".repeat(64), 1), mk("c".repeat(64), 2)],
  });
  eq(edges.length, 0, "sharing a block is not membership; only a shared REVEAL is");
});

test("sharing a tick is not membership: only chain-declared parentage is", () => {
  // Same `tick` in the body, different reveals. A vendor would group these as
  // "the sats token". The archive must not: nothing on chain says they are
  // one collection, and inventing that link is how a fungible ticker becomes
  // a fake NFT collection with a six-digit supply.
  const bodies = [
    '{"p":"brc-20","op":"transfer","amt":"1","tick":"sats"}',
    '{"p":"brc-20","op":"transfer","amt":"2","tick":"sats"}',
  ];
  const ids = bodies.map((b, i) => {
    const txid = String(i).repeat(64).slice(0, 64);
    const found = parseEnvelopes(envelopeFor(b), { revealTxid: txid, inputIndex: 0 }, sha);
    return found[0]!;
  });

  eq(ids.length, 2);
  ok(ids[0]!.id !== ids[1]!.id, "two reveals are two inscriptions");
  ok(
    ids.every((i) => i.parent === null),
    "neither declares a parent, so the archive has no basis to join them",
  );
});

test("a PARENT declaration is the only thing that binds inscriptions", () => {
  // The contrast case: this is what real collection membership looks like.
  // It comes from the creator's own on-chain declaration, not from a payload
  // field and not from a venue.
  const edges = deriveHardEdges({
    chain: "bitcoin",
    events: [],
    parents: [{ child: "0xchildi0", parent: "0xparenti0", blockHash: "0xb", loc: 0 }],
  });
  eq(edges.length, 1);
  eq(edges[0]!.kind, "PARENT", "membership is declared on chain or it does not exist");
});
