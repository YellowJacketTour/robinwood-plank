import assert from "node:assert/strict";
import test from "node:test";
import { parseAssetProvenance, type RawDasAsset } from "../../lib/market/multichain/discovery/solana-compressed-provenance";

/**
 * Fixtures below are the REAL response bodies captured live 2026-08-24
 * against a live QuickNode DAS endpoint (getAsset/searchAssets) -- see
 * solana-compressed-provenance.ts's file header for the full citation.
 * Trimmed to only the fields this parser reads.
 */

const REAL_COMPRESSED_NFT: RawDasAsset = {
  id: "JEKNVjohV7ALhZbHgCwuCFCJKxnfPom2fR4eniHCmP39",
  interface: "V1_NFT",
  burnt: false,
  compression: {
    eligible: false,
    compressed: true,
    data_hash: "6dUQbpocaLMxwr6WQfAEEhWfGcNBSiVZL5QWyvaLtLbK",
    creator_hash: "8PHadTXZB7hRtevswNpDsHtz63m2pFhKPKeq6CLvCuTt",
    asset_hash: "FTX4JuB36obtjcNqnZxW7NBxnKeB2mEbS1JgSJFiCV39",
    tree: "9oFp2PM6k1b5mmzpeHUaZkCAbTD1ykR4QiyQYu3EVnfK",
    seq: 534799,
    leaf_id: 533886,
  } as never,
  ownership: {
    frozen: false,
    delegated: true,
    delegate: "9fqdPWz2ynV9aNtkYXtL49hbhzU4mB7wWzjvUVidrdep",
    ownership_model: "single",
    owner: "4ZpmpcWAdacYFdMVbsGz2e7rGCJxtVAJ8GMdaa4gto9x",
  },
  grouping: [{ group_key: "collection", group_value: "5DJAyCm2jU1f87s2RUzBEcN21uY53PvmEeTC3AsKgiJt" }],
};

const REAL_NONCOMPRESSED_PNFT: RawDasAsset = {
  id: "JEGruwYE13mhX2wi2MGrPmeLiVyZtbBptmVy9vG3pXRC",
  interface: "ProgrammableNFT",
  burnt: false,
  compression: { eligible: false, compressed: false, data_hash: "", creator_hash: "", asset_hash: "", tree: "", seq: 0, leaf_id: 0 } as never,
  ownership: { frozen: true, delegated: true, delegate: "FARqKAafAbgT25QcgiX5d1g6xpadgG7xymu5N6gSmp4x", ownership_model: "single", owner: "CxBhuJwhVgNMc7yjnRx3XFAsTnnbYDc2bhAGSaLBjNqZ" },
  grouping: [{ group_key: "collection", group_value: "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w" }],
};

const REAL_CORE_ASSET_WITH_PLUGIN: RawDasAsset = {
  id: "JEKMYS4ccuy9fG4CWEK81DFi9rxEyyLKZKTKTQ9pj2aC",
  interface: "MplCoreAsset",
  burnt: false,
  grouping: [{ group_key: "collection", group_value: "9BSPDYdLa3qAUEwinRZ2R1psekpP31RqPAScL3n2JVgN" }],
  ownership: { frozen: false, delegated: false, delegate: null, ownership_model: "single", owner: "FposRG79yqwn99aWexddKNmusyYtbPesxHab2K1Y6M9Q" },
  plugins: { edition: { data: { number: 178231 }, index: 0, offset: 182, authority: { type: "None", address: null } } },
};

test("parseAssetProvenance surfaces a real compressed NFT's full compression proof + ownership", () => {
  const parsed = parseAssetProvenance(REAL_COMPRESSED_NFT);
  assert.equal(parsed.compressed, true);
  assert.ok(parsed.compressionProof);
  assert.equal(parsed.compressionProof?.tree, "9oFp2PM6k1b5mmzpeHUaZkCAbTD1ykR4QiyQYu3EVnfK");
  assert.equal(parsed.compressionProof?.leafId, 533886);
  assert.equal(parsed.compressionProof?.seq, 534799);
  assert.equal(parsed.ownership.owner, "4ZpmpcWAdacYFdMVbsGz2e7rGCJxtVAJ8GMdaa4gto9x");
  assert.equal(parsed.ownership.delegated, true);
  assert.equal(parsed.collectionGroup, "5DJAyCm2jU1f87s2RUzBEcN21uY53PvmEeTC3AsKgiJt");
  assert.equal(parsed.plugins, null);
});

test("parseAssetProvenance reports compressionProof null for a real non-compressed pNFT (zeroed compression block)", () => {
  const parsed = parseAssetProvenance(REAL_NONCOMPRESSED_PNFT);
  assert.equal(parsed.compressed, false);
  assert.equal(parsed.compressionProof, null);
  assert.equal(parsed.ownership.owner, "CxBhuJwhVgNMc7yjnRx3XFAsTnnbYDc2bhAGSaLBjNqZ");
});

test("parseAssetProvenance surfaces a real Metaplex Core asset's plugin bag verbatim", () => {
  const parsed = parseAssetProvenance(REAL_CORE_ASSET_WITH_PLUGIN);
  assert.equal(parsed.interfaceKind, "MplCoreAsset");
  assert.equal(parsed.compressed, false);
  assert.ok(parsed.plugins);
  assert.deepEqual(parsed.plugins?.edition, { data: { number: 178231 }, index: 0, offset: 182, authority: { type: "None", address: null } });
  assert.equal(parsed.collectionGroup, "9BSPDYdLa3qAUEwinRZ2R1psekpP31RqPAScL3n2JVgN");
});

test("parseAssetProvenance never fabricates a compression proof from a partial/malformed compression block", () => {
  const partial: RawDasAsset = {
    id: "x",
    compression: { compressed: true, tree: "sometree" } as never, // missing leaf_id/seq/hashes -- real malformed/partial case
  };
  const parsed = parseAssetProvenance(partial);
  assert.equal(parsed.compressed, true); // the flag itself is real
  assert.equal(parsed.compressionProof, null); // but an incomplete proof is never presented as if it were complete
});

test("parseAssetProvenance defaults ownership/burnt/plugins honestly when entirely absent", () => {
  const bare: RawDasAsset = { id: "y" };
  const parsed = parseAssetProvenance(bare);
  assert.equal(parsed.burnt, false);
  assert.equal(parsed.ownership.owner, null);
  assert.equal(parsed.collectionGroup, null);
  assert.equal(parsed.plugins, null);
});
