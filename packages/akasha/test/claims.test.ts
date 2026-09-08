/**
 * Claim kits: a number the product shows must carry the evidence to recompute it.
 *
 * The floor tests are the ones that pay for themselves. Production shipped a
 * bare `floorPriceWei`, and a bare floor is a claim about a SEARCH nobody
 * performed -- venue-held asks are not on-chain, so "no lower ask exists" is
 * unprovable on every chain we index and simply false on Bitcoin.
 */
import { test } from "node:test";
import { eq, ok, throws, sha256Stub } from "./_expect.ts";
import { verifyClaimKit, assertTypedFloor, registerProgram, type ClaimKit } from "../src/claims/program.ts";
import { runHolders, holdersClaimKind, type TransferInput } from "../src/claims/holders.ts";
import { runExhibitFloor, isExhibitable, assertNoGlobalFloorClaim, type ExhibitedOrder } from "../src/claims/floor.ts";
import { runTraits, traitsClaimKind, assertNotMixedSilently, type TraitBody } from "../src/claims/traits.ts";

const sha = sha256Stub();
const shaHex = (s: string) => sha(new TextEncoder().encode(s));

// --- floor -----------------------------------------------------------------

const ORDERS: ExhibitedOrder[] = [
  // Cheapest, but cancelled on-chain: showing 50 would quote a price nobody can pay.
  { orderHash: "0xcancelled", priceAtomic: "50", signature: "0xsig", cancelled: true, filled: false, expiresAt: 0 },
  // Cheaper still, but unsigned: not an order, just a wish.
  { orderHash: "0xunsigned", priceAtomic: "10", signature: null, cancelled: false, filled: false, expiresAt: 0 },
  // Expired.
  { orderHash: "0xexpired", priceAtomic: "20", signature: "0xsig", cancelled: false, filled: false, expiresAt: 1_000 },
  // A PSBT whose input was already spent: the classic Bitcoin ghost ask.
  { orderHash: "0xspent", priceAtomic: "30", signature: "0xsig", cancelled: false, filled: false, expiresAt: 0, inputsUnspent: false },
  // The real answer.
  { orderHash: "0xvalid", priceAtomic: "100", signature: "0xsig", cancelled: false, filled: false, expiresAt: 0 },
  { orderHash: "0xhigher", priceAtomic: "250", signature: "0xsig", cancelled: false, filled: false, expiresAt: 0 },
];

test("the cheapest EXHIBITABLE order is 100, not the invalid 50", () => {
  const out = runExhibitFloor([{ asOfUnix: 2_000, orders: ORDERS }]);
  eq(out.priceAtomic, "100", "cancelled/unsigned/expired/spent asks are not prices");
  eq(out.orderHash, "0xvalid");
  eq(out.consideredCount, 6);
  eq(out.validCount, 2, "only two of six survive");
});

test("each exhibitability rule rejects independently", () => {
  const asOf = 2_000;
  eq(isExhibitable(ORDERS[0]!, asOf), false, "cancelled");
  eq(isExhibitable(ORDERS[1]!, asOf), false, "unsigned");
  eq(isExhibitable(ORDERS[2]!, asOf), false, "expired");
  eq(isExhibitable(ORDERS[3]!, asOf), false, "inputs spent");
  eq(isExhibitable(ORDERS[4]!, asOf), true, "valid");
});

test("no exhibitable order yields null, never a stale or invented number", () => {
  const out = runExhibitFloor([{ asOfUnix: 2_000, orders: [ORDERS[0]!, ORDERS[1]!] }]);
  eq(out.priceAtomic, null, "an honest absence beats a confident wrong answer");
  eq(out.validCount, 0);
});

test("atomic price comparison does not lose precision on big integers", () => {
  const wei = (h: string, p: string): ExhibitedOrder => ({
    orderHash: h, priceAtomic: p, signature: "0xs", cancelled: false, filled: false, expiresAt: 0,
  });
  // These differ in the last wei and both exceed Number.MAX_SAFE_INTEGER.
  const out = runExhibitFloor([{
    asOfUnix: 0,
    orders: [wei("0xa", "10000000000000000001"), wei("0xb", "10000000000000000000")],
  }]);
  eq(out.orderHash, "0xb", "string-length-then-lexical compare, never Number()");
});

test("bare floor kinds throw; typed kinds pass", () => {
  throws(() => assertTypedFloor("floor"), /not a claim kind/);
  throws(() => assertTypedFloor("floorPriceWei"), /not a claim kind/);
  throws(() => assertTypedFloor("price"), /not a claim kind/);
  throws(() => assertTypedFloor("cheapest"), /unknown claim kind/);
  assertTypedFloor("min_exhibited_valid_order");
  assertTypedFloor("amm_state");
});

test("the global-floor sentence cannot be written", () => {
  throws(() => assertNoGlobalFloorClaim("The floor is 0.42 ETH"), /unprovable/);
  throws(() => assertNoGlobalFloorClaim("no lower ask exists"), /unprovable/);
  assertNoGlobalFloorClaim("min_exhibited_valid_order: 0.42 ETH");
});

// --- holders ---------------------------------------------------------------

test("holders replay orders by HEIGHT first, not loc alone", () => {
  // The exact bug the earlier draft had: block 900 loc 1 must beat block 100 loc 2.
  const transfers: TransferInput[] = [
    { height: 900, loc: 1, blockHash: "0xb9", contract: "0xc", tokenId: "1", from: "0xA", to: "0xFINAL" },
    { height: 100, loc: 2, blockHash: "0xb1", contract: "0xc", tokenId: "1", from: "0x0", to: "0xA" },
  ];
  const out = runHolders(transfers);
  eq(out.owners, [["1", "0xfinal"]], "the LAST transfer by (height, loc) wins");
  eq(out.uniqueOwners, 1);
});

test("a burn removes supply rather than crediting the zero address", () => {
  const out = runHolders([
    { height: 1, loc: 0, blockHash: "0xb", contract: "0xc", tokenId: "1", from: "0x0000000000000000000000000000000000000000", to: "0xA" },
    { height: 2, loc: 0, blockHash: "0xb", contract: "0xc", tokenId: "2", from: "0x0000000000000000000000000000000000000000", to: "0xA" },
    { height: 3, loc: 0, blockHash: "0xb", contract: "0xc", tokenId: "2", from: "0xA", to: "0x0000000000000000000000000000000000000000" },
  ]);
  eq(out.supply, 1, "a burned token is not supply");
  eq(out.uniqueOwners, 1, "and the zero address is not a holder");
});

test("partial coverage is a different claim kind, not a footnote", () => {
  eq(holdersClaimKind(true), "holders_at_block");
  eq(holdersClaimKind(false), "holders_at_block_partial",
    "a count from a tape that misses genesis must not look complete");
});

// --- traits ----------------------------------------------------------------

const CA: TraitBody = { tokenId: "1", contentAddressed: true, attributes: [{ trait_type: "Hat", value: "Cap" }] };
const MUT: TraitBody = { tokenId: "2", contentAddressed: false, attributes: [{ trait_type: "Hat", value: "Cap" }] };

test("one mutable body demotes the whole trait claim", () => {
  eq(traitsClaimKind([CA, CA]), "traits_content_addressed");
  eq(traitsClaimKind([CA, MUT]), "traits_under_obs", "completeness is set-wide, not per-token");
  throws(() => assertNotMixedSilently([CA, MUT], "traits_content_addressed"), /may not be merged/);
});

test("the trait histogram is sorted, so two archives can be diffed byte-for-byte", () => {
  const out = runTraits([
    { tokenId: "1", contentAddressed: true, attributes: [{ trait_type: "Zed", value: "b" }, { trait_type: "Abe", value: "z" }] },
    { tokenId: "2", contentAddressed: true, attributes: [{ trait_type: "Abe", value: "a" }] },
  ]);
  eq(out.histogram.map((h) => h[0]), ["Abe", "Zed"]);
  eq(out.histogram[0]![1], [["a", 1], ["z", 1]]);
});

// --- kit verification ------------------------------------------------------

test("a stranger recomputes the kit with no archive handle, and altered inputs fail", () => {
  const inputs: TransferInput[] = [
    { height: 1, loc: 0, blockHash: "0xb", contract: "0xc", tokenId: "1", from: "0x0", to: "0xAAA" },
  ];
  const kit: ClaimKit<TransferInput, ReturnType<typeof runHolders>> = {
    claim: {
      kind: "holders_at_block",
      subject: "eth:0xc",
      value: runHolders(inputs),
      asOf: { chain: "ethereum", height: 1, blockHash: "0xb" as `0x${string}` },
    },
    programId: "holders.v1",
    inputs,
    inputDigest: shaHex(JSON.stringify(inputs)),
  };

  eq(verifyClaimKit(kit as ClaimKit, { sha256Hex: shaHex }).ok, true);

  // Swap the destination: the digest no longer matches, so tampering is caught
  // before the program even runs.
  const tampered = { ...kit, inputs: [{ ...inputs[0]!, to: "0xEVIL" }] };
  const bad = verifyClaimKit(tampered as ClaimKit, { sha256Hex: shaHex });
  eq(bad.ok, false);
  ok(/input digest mismatch/.test(bad.reason));
});

test("a claim whose value disagrees with its own inputs is rejected", () => {
  const inputs: TransferInput[] = [
    { height: 1, loc: 0, blockHash: "0xb", contract: "0xc", tokenId: "1", from: "0x0", to: "0xAAA" },
  ];
  const kit = {
    claim: {
      kind: "holders_at_block",
      subject: "eth:0xc",
      value: { uniqueOwners: 9999, supply: 9999, owners: [] },
      asOf: { chain: "ethereum", height: 1, blockHash: "0xb" },
    },
    programId: "holders.v1",
    inputs,
    inputDigest: shaHex(JSON.stringify(inputs)),
  } as unknown as ClaimKit;

  const r = verifyClaimKit(kit, { sha256Hex: shaHex });
  eq(r.ok, false, "the packer cannot lie about the result of its own program");
  ok(/recomputed value differs/.test(r.reason));
});

test("an unknown program is a refusal, not a pass", () => {
  const kit = {
    claim: { kind: "holders_at_block", subject: "x", value: null, asOf: { chain: "ethereum", height: 1, blockHash: "0xb" } },
    programId: "not.registered.v1",
    inputs: [],
    inputDigest: shaHex("[]"),
  } as unknown as ClaimKit;
  eq(verifyClaimKit(kit, { sha256Hex: shaHex }).ok, false);
});

test("a program that throws fails closed", () => {
  registerProgram("explodes.v1", () => { throw new Error("boom"); });
  const kit = {
    claim: { kind: "amm_state", subject: "x", value: 1, asOf: { chain: "ethereum", height: 1, blockHash: "0xb" } },
    programId: "explodes.v1",
    inputs: [],
    inputDigest: shaHex("[]"),
  } as unknown as ClaimKit;
  const r = verifyClaimKit(kit, { sha256Hex: shaHex });
  eq(r.ok, false);
  ok(/program threw: boom/.test(r.reason));
});
