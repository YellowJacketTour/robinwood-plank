/**
 * Cluster identity: the mall trap and the hard/soft separation.
 *
 * The mall test is the one that matters most. If Shared Storefront collapses
 * into one cluster, the archive reports a single collection with a six-digit
 * supply and every downstream number is wrong in a way no later fix repairs.
 */
import { test } from "node:test";
import { eq, ok, throws, sha256Stub } from "./_expect.ts";
import type { ChainEvent } from "../src/shared/types.ts";
import { deriveHardEdges, detectMall, uriPrefix, MALL_MIN_MINTERS } from "../src/cluster/derive.ts";
import {
  HardUnionFind,
  clusterId,
  candidateConfidence,
  shouldPromote,
  attentionMayCreateEdge,
  SOFT_WEIGHT,
} from "../src/cluster/graph.ts";

const sha = sha256Stub();
const shaHex = (s: string) => sha(new TextEncoder().encode(s));

function mint(contract: string, tokenId: string, to: string, loc: number): ChainEvent {
  return {
    chain: "ethereum",
    blockHash: "0xblock" as `0x${string}`,
    height: 100,
    loc,
    txHash: "0xtx" as `0x${string}`,
    kind: "transfer721",
    contractOrProgram: contract,
    tokenOrInscription: tokenId,
    fromAddr: "0x0000000000000000000000000000000000000000",
    toAddr: to,
    raw: {},
  };
}

test("a normal collection is ONE cluster: many buyers, one uri prefix", () => {
  // 20 tokens minted to 20 different wallets, all metadata under one prefix.
  const events = Array.from({ length: 60 }, (_, i) =>
    mint("0xcollection", String(i), `0xowner${i}`, i)
  );
  const uriFor = () => "ipfs://bafyOneCollection/meta.json";

  const verdict = detectMall(events, uriFor);
  eq(verdict.isMall, false, "many minters but ONE uri prefix is not a mall");

  const edges = deriveHardEdges({ chain: "ethereum", events, uriFor });
  ok(
    edges.every((e) => e.kind === "CONTRACT"),
    "a normal contract yields CONTRACT edges, not slices"
  );
});

test("a shared storefront SLICES and never becomes one collection", () => {
  // 60 tokens, 12 creators, each with their own metadata path: a mall.
  const events = Array.from({ length: 60 }, (_, i) =>
    mint("0xsharedstorefront", String(i), `0xcreator${i % 12}`, i)
  );
  const uriFor = (tokenId: string) =>
    `https://storefront.test/creator${Number(tokenId) % 12}/${tokenId}.json`;

  const verdict = detectMall(events, uriFor);
  eq(verdict.isMall, true, `expected a mall: ${verdict.reason}`);
  ok(verdict.distinctMinters >= MALL_MIN_MINTERS);

  const edges = deriveHardEdges({ chain: "ethereum", events, uriFor });
  eq(
    edges.some((e) => e.kind === "CONTRACT"),
    false,
    "a mall must NEVER emit a CONTRACT edge -- that is the collapse"
  );
  ok(
    edges.every((e) => e.kind === "STOREFRONT_SLICE"),
    "a mall emits slice edges only"
  );

  // The slices must be genuinely separate clusters.
  const uf = new HardUnionFind();
  for (const e of edges) uf.add(e);
  const groups = uf.groups();
  ok(groups.size >= 12, `expected >= 12 slices, got ${groups.size}`);
});

test("same-reveal inscriptions are one cluster; a lone inscription is not", () => {
  const batch: ChainEvent[] = [0, 1, 2, 3].map((i) => ({
    chain: "bitcoin",
    blockHash: "0xb" as `0x${string}`,
    height: 5,
    loc: i,
    txHash: "0xreveal" as `0x${string}`,
    kind: "envelope",
    contractOrProgram: "ord",
    tokenOrInscription: `0xreveali${i}`,
    fromAddr: "",
    toAddr: "",
    raw: {},
  }));
  const solo: ChainEvent = { ...batch[0]!, txHash: "0xsolo" as `0x${string}`, tokenOrInscription: "0xsoloi0", loc: 9 };

  const edges = deriveHardEdges({ chain: "bitcoin", events: [...batch, solo] });
  const reveals = edges.filter((e) => e.kind === "SAME_REVEAL");
  eq(reveals.length, 3, "4 inscriptions in one reveal = 3 edges to the first");
  ok(
    !reveals.some((e) => e.a === "0xsoloi0" || e.b === "0xsoloi0"),
    "a single-inscription reveal announces nothing about membership"
  );
});

test("an ordinals parent declaration is a hard edge", () => {
  const edges = deriveHardEdges({
    chain: "bitcoin",
    events: [],
    parents: [{ child: "0xchildi0", parent: "0xparenti0", blockHash: "0xb", loc: 0 }],
  });
  eq(edges.length, 1);
  eq(edges[0]!.kind, "PARENT");
});

test("cluster_id is a hash of witnesses, order-independent", () => {
  const a = clusterId("bitcoin", [{ blockHash: "0x1", loc: 2 }, { blockHash: "0x0", loc: 1 }], shaHex);
  const b = clusterId("bitcoin", [{ blockHash: "0x0", loc: 1 }, { blockHash: "0x1", loc: 2 }], shaHex);
  eq(a, b, "witness order must not change identity");

  const c = clusterId("ethereum", [{ blockHash: "0x0", loc: 1 }, { blockHash: "0x1", loc: 2 }], shaHex);
  ok(a !== c, "the same witnesses on another chain are a different cluster");
});

test("one soft edge never promotes, and attention can never create an edge", () => {
  const one = [{ kind: "FUNDED_BY" as const, a: "x", b: "y", weight: SOFT_WEIGHT.FUNDED_BY }];
  const conf = candidateConfidence(one);
  eq(shouldPromote({ artifactId: "y", edges: one, confidence: conf }, false), false,
    "a single common-funding guess must not merge two projects");

  // Two edges of the SAME kind are still one signal.
  const same = [
    { kind: "SEQUENCE" as const, a: "x", b: "y", weight: 0.3 },
    { kind: "SEQUENCE" as const, a: "x", b: "z", weight: 0.3 },
  ];
  eq(shouldPromote({ artifactId: "y", edges: same, confidence: candidateConfidence(same) }, false), false);

  // A market naming it alongside a member is an independent announcement.
  eq(shouldPromote({ artifactId: "y", edges: one, confidence: conf }, true), true);

  throws(() => attentionMayCreateEdge(), /scheduler, not a source of identity/);
});

test("uriPrefix names the publisher, not just the host", () => {
  // An IPFS directory CID IS the publisher; what follows is its own layout.
  eq(uriPrefix("ipfs://bafyabc/1.json"), "bafyabc");
  eq(uriPrefix("ipfs://bafyabc/deep/nested/1.json"), "bafyabc");

  // On shared infrastructure the host is not a namespace. These two are
  // different creators and must not report the same prefix -- host-only was
  // the bug that made Shared Storefront look like one collection.
  ok(
    uriPrefix("https://storefront.test/creator1/2.json") !==
      uriPrefix("https://storefront.test/creator9/8.json"),
    "two creators on one host are two namespaces"
  );

  // But an ordinary collection serving /meta/<id>.json is still ONE prefix.
  eq(
    uriPrefix("https://api.mycollection.test/meta/1.json"),
    uriPrefix("https://api.mycollection.test/meta/9999.json"),
    "per-token filenames must not fork the namespace"
  );

  eq(uriPrefix("https://api.mycollection.test/1.json"), "api.mycollection.test");
  eq(uriPrefix(null), null);
});
