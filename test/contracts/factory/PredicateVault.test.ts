import { expect } from "chai";
import { ethers } from "../helpers/hardhat.js";
import { takeSnapshot, type SnapshotRestorer } from "../helpers/network-helpers.js";

/**
 * PHASE 2 — predicate vaults (closes audit C-5).
 *
 * DESIGN-HONEST-INDEX-2026-08-09 §2: a vault is `(collection, predicate)`, the
 * predicate is an IMMUTABLE merkle root over eligible tokenIds, and vault
 * creation stays permissionless.
 *
 * WOULD THESE GO RED IF THE MECHANISM BROKE? Every test below names the exact
 * mutation it detects:
 *  - "rejects an ineligible token"        -> delete the `MerkleProof.verify`
 *                                            check and this passes a deposit
 *                                            of an out-of-band token.
 *  - "rejects a valid proof for the wrong tokenId" -> same, plus it catches a
 *                                            leaf built from the wrong field.
 *  - "accepts every in-set token"          -> catches an over-strict predicate
 *                                            (a root that admits nothing is
 *                                            also broken).
 *  - "has no setter"                       -> enumerates the ABI; catches
 *                                            anyone ever adding one. This is
 *                                            an ABI-shape assertion, not a
 *                                            source grep — it reads the
 *                                            COMPILED interface.
 *  - "C-5 is closed"                       -> the audit's own 0.02-ETH
 *                                            junk-for-treasure trade, executed
 *                                            against a predicate vault; it
 *                                            reverts, and the same trade
 *                                            against an OPEN vault SUCCEEDS in
 *                                            the same test, so the assertion
 *                                            cannot pass by both branches
 *                                            being trivially true.
 */

const TIMELOCK = 48 * 3600;
const ZERO_ROOT = ethers.ZeroHash;

// ── minimal sorted-pair merkle tree over double-hashed tokenId leaves ──────
// Mirrors `CollectionVault`'s own encoding:
//   leaf = keccak256(keccak256(abi.encode(tokenId)))
// and OpenZeppelin `MerkleProof.verify`'s sorted-pair internal hashing.
function leafOf(tokenId: number | bigint): string {
  const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [tokenId]));
  return ethers.keccak256(inner);
}

function hashPair(a: string, b: string): string {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

function buildTree(tokenIds: (number | bigint)[]) {
  const leaves = tokenIds.map(leafOf);
  const layers: string[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  const root = layers[layers.length - 1][0];
  function proof(tokenId: number | bigint): string[] {
    let idx = leaves.indexOf(leafOf(tokenId));
    if (idx < 0) throw new Error("not in tree");
    const p: string[] = [];
    for (let l = 0; l < layers.length - 1; l++) {
      const sib = idx ^ 1;
      if (sib < layers[l].length) p.push(layers[l][sib]);
      idx = Math.floor(idx / 2);
    }
    return p;
  }
  return { root, proof };
}

describe("Phase 2 — predicate vaults (audit C-5)", () => {
  let snap: SnapshotRestorer;
  before(async () => { snap = await takeSnapshot(); });
  after(async () => { await snap.restore(); });

  // the eligible band: a tight, homogeneous set
  const ELIGIBLE = [11, 12, 13, 14, 15, 16, 17];
  const tree = buildTree(ELIGIBLE);

  async function fixture(root: string) {
    const [deployer, sink, treasury, alice] = await ethers.getSigners();
    const payment: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("PAY", "PAY");
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(sink.address, await payment.getAddress(), TIMELOCK);

    const nftAddr = await nft.getAddress();
    let vaultAddr: string;
    if (root === ZERO_ROOT) {
      vaultAddr = await factory.deployVault.staticCall(nftAddr, treasury.address, 810);
      await factory.deployVault(nftAddr, treasury.address, 810);
    } else {
      vaultAddr = await factory.deployPredicateVault.staticCall(nftAddr, treasury.address, 810, root);
      await factory.deployPredicateVault(nftAddr, treasury.address, 810, root);
    }
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);
    for (const who of [alice, treasury, deployer]) {
      await payment.mint(who.address, ethers.parseEther("1000"));
      await payment.connect(who).approve(vaultAddr, ethers.MaxUint256);
    }
    return { deployer, sink, treasury, alice, payment, nft, factory, vault, vaultAddr };
  }

  async function giveNft(nft: any, to: any, vaultAddr: string, id: number) {
    await nft.mint(to.address, id);
    await nft.connect(to).approve(vaultAddr, id);
  }

  it("stores the root as immutable and exposes NO setter for it anywhere in the ABI", async () => {
    const { vault } = await fixture(tree.root);
    expect(await vault.eligibilityRoot()).to.equal(tree.root);

    // Read the COMPILED interface, not the source text. A source grep is what
    // the audit's meta-finding calls out as structurally incapable of proving
    // anything; the ABI is the actual, complete external surface.
    const iface = (await ethers.getContractFactory("CollectionVault")).interface;
    const mutators = iface.fragments
      .filter((f: any) => f.type === "function")
      .filter((f: any) => f.stateMutability !== "view" && f.stateMutability !== "pure")
      .map((f: any) => f.name);
    // Nothing may write the predicate: no setter, and no queue/execute pair
    // either (the treasury and split each have one — the predicate must not).
    for (const name of mutators) {
      expect(
        /eligib|predicate|root/i.test(name),
        `CollectionVault exposes a state-changing function "${name}" that names the predicate — the immutability guarantee is broken`
      ).to.equal(false);
    }
  });

  it("accepts EVERY in-set tokenId with its proof (the predicate is not merely restrictive)", async () => {
    const { vault, vaultAddr, alice, nft } = await fixture(tree.root);
    for (const id of ELIGIBLE) {
      await giveNft(nft, alice, vaultAddr, id);
      await vault.connect(alice).depositWithProof(id, tree.proof(id));
      expect(await vault.isTokenHeld(id)).to.equal(true);
    }
    expect(await vault.balanceOf(alice.address)).to.equal(ethers.parseEther(String(ELIGIBLE.length)));
  });

  it("rejects an out-of-band tokenId — with any proof, and with none", async () => {
    const { vault, vaultAddr, alice, nft } = await fixture(tree.root);
    const junk = 9999;
    await giveNft(nft, alice, vaultAddr, junk);

    // no proof at all
    await expect(vault.connect(alice).depositWithProof(junk, [])).to.be.revertedWithCustomError(
      vault,
      "NotEligible"
    );
    // a VALID proof, but for a different (eligible) tokenId — the classic
    // proof-reuse attempt. Catches a leaf built from the wrong field.
    await expect(
      vault.connect(alice).depositWithProof(junk, tree.proof(ELIGIBLE[0]))
    ).to.be.revertedWithCustomError(vault, "NotEligible");
    // and the bare `deposit` convenience door is closed on a predicate vault
    await expect(vault.connect(alice).deposit(junk)).to.be.revertedWithCustomError(vault, "ProofRequired");

    expect(await vault.isTokenHeld(junk)).to.equal(false);
    expect(await vault.balanceOf(alice.address)).to.equal(0n);
  });

  it("isEligible agrees with what deposit actually does", async () => {
    const { vault } = await fixture(tree.root);
    expect(await vault.isEligible(ELIGIBLE[3], tree.proof(ELIGIBLE[3]))).to.equal(true);
    expect(await vault.isEligible(9999, tree.proof(ELIGIBLE[3]))).to.equal(false);
    expect(await vault.isEligible(9999, [])).to.equal(false);
  });

  it("an OPEN vault (root == 0) keeps the pre-Phase-2 behaviour exactly", async () => {
    const { vault, vaultAddr, alice, nft } = await fixture(ZERO_ROOT);
    expect(await vault.eligibilityRoot()).to.equal(ZERO_ROOT);
    await giveNft(nft, alice, vaultAddr, 4242);
    await vault.connect(alice).deposit(4242); // no proof needed
    expect(await vault.isTokenHeld(4242)).to.equal(true);
    // and the proof-taking door also accepts anything, with an empty proof
    await giveNft(nft, alice, vaultAddr, 4243);
    await vault.connect(alice).depositWithProof(4243, []);
    expect(await vault.isTokenHeld(4243)).to.equal(true);
  });

  it("C-5: the audit's 0.02-ETH junk-for-treasure trade WORKS on an open vault and is IMPOSSIBLE on a predicate vault", async () => {
    // The eligible band models the 'treasure'; 9001 models the 1-ETH floor junk.
    const JUNK = 9001;
    const GRAIL = ELIGIBLE[0];

    // ── control arm: the open vault. This MUST succeed, otherwise the
    // predicate arm below proves nothing (the audit's meta-finding #1 in
    // exactly one line).
    {
      const { vault, vaultAddr, alice, treasury, nft } = await fixture(ZERO_ROOT);
      await giveNft(nft, treasury, vaultAddr, GRAIL);
      await vault.connect(treasury).deposit(GRAIL); // vault now holds the grail
      await giveNft(nft, alice, vaultAddr, JUNK);
      await vault.connect(alice).deposit(JUNK); // 0.01 ETH fee, alice holds 1 S
      await vault.connect(alice).redeem(GRAIL); // 0.01 ETH fee, alice takes the grail
      expect(await nft.ownerOf(GRAIL)).to.equal(alice.address);
    }

    // ── treatment arm: the same trade against a predicate vault.
    {
      const { vault, vaultAddr, alice, treasury, nft } = await fixture(tree.root);
      await giveNft(nft, treasury, vaultAddr, GRAIL);
      await vault.connect(treasury).depositWithProof(GRAIL, tree.proof(GRAIL));
      await giveNft(nft, alice, vaultAddr, JUNK);
      // The junk can never become 1e18 S, so alice can never buy the exit.
      await expect(vault.connect(alice).depositWithProof(JUNK, [])).to.be.revertedWithCustomError(
        vault,
        "NotEligible"
      );
      // and without S she cannot redeem the grail either
      await expect(vault.connect(alice).redeem(GRAIL)).to.be.revert(ethers);
      expect(await nft.ownerOf(GRAIL)).to.equal(vaultAddr);
    }
  });

  it("a collection may host several vaults with DIFFERENT predicates, and the same (collection, root) twice reverts", async () => {
    const [, sink, treasury] = await ethers.getSigners();
    const payment: any = await (await ethers.getContractFactory("MockIndexToken")).deploy("PAY", "PAY");
    const nft: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const factory: any = await (
      await ethers.getContractFactory("CollectionVaultFactory")
    ).deploy(sink.address, await payment.getAddress(), TIMELOCK);
    const nftAddr = await nft.getAddress();

    const other = buildTree([101, 102, 103]);

    const predicted = await factory.predictPredicateVault(nftAddr, treasury.address, 810, tree.root);
    await factory.deployPredicateVault(nftAddr, treasury.address, 810, tree.root);
    expect(await factory.vaultForCollection(await factory.vaultSalt(nftAddr, tree.root))).to.equal(predicted);

    // a DIFFERENT predicate over the SAME collection is a different vault
    await factory.deployPredicateVault(nftAddr, treasury.address, 810, other.root);
    // and the open vault is a third
    await factory.deployVault(nftAddr, treasury.address, 810);
    expect(await factory.vaultCount()).to.equal(3n);

    // but the same (collection, root) pair is still a hard collision
    await expect(
      factory.deployPredicateVault(nftAddr, treasury.address, 810, tree.root)
    ).to.be.revertedWithCustomError(factory, "VaultAlreadyExists");
    await expect(factory.deployVault(nftAddr, treasury.address, 810)).to.be.revertedWithCustomError(
      factory,
      "VaultAlreadyExists"
    );
  });
});
