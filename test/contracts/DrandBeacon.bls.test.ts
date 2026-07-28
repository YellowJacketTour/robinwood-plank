import { expect } from "chai";
import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";
import * as BLS from "./helpers/bls-bn254";

/**
 * THE LOAD-BEARING TEST OF THE WHOLE randomness rework.
 *
 * DrandBeacon only ever caches randomness it has cryptographically verified.
 * If the verifier could be fooled, every guarantee above it is theatre. So
 * this file drives REAL BN254 BLS signatures — produced with @noble/curves'
 * independent pairing implementation, over a keypair generated here — through
 * the actual on-chain pairing precompile path, and proves the contract
 * accepts genuine signatures and rejects forged ones.
 *
 * No mock is involved anywhere in this file.
 */
describe("DrandBeacon — BN254 BLS verification (real signatures)", () => {
  // A deterministic test keypair. Stands in for the drand group key, which is
  // structurally identical (a G2 point) — the network's key is a threshold
  // key, but verification is against a single aggregate public key either way.
  const SK = 0x2f7a1c93b45e6d80a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182n % BLS.R;
  const DOMAIN = BLS.DRAND_BN254_DOMAIN;
  const GENESIS = 1_700_000_000;
  const PERIOD = 3;
  const CHAIN_HASH = ethers.id("test-chain-hash");

  async function deployBeacon() {
    const pk = BLS.publicKeyG2(SK);
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon: any = await Beacon.deploy(
      CHAIN_HASH,
      pk,
      GENESIS,
      PERIOD,
      ethers.toUtf8Bytes(DOMAIN)
    );
    return { beacon, pk };
  }

  async function deployHarness() {
    const H = await ethers.getContractFactory("BLSHarness");
    return (await H.deploy()) as any;
  }

  it("the Solidity constants are the RFC 9380 SvdW constants, re-derived independently", async () => {
    const h = await deployHarness();
    const [p, c1, c2, c3, c4, zPad] = (await h.constants()) as bigint[];
    expect(p).to.equal(BLS.P);
    expect(c1).to.equal(BLS.C1);
    expect(c2).to.equal(BLS.C2);
    expect(c3).to.equal(BLS.C3);
    expect(c4).to.equal(BLS.C4);
    // The interop-critical one: expand_message_xmd's zero pad must be the
    // hash's INPUT BLOCK SIZE. keccak256's is 136 (its sponge rate), not 64.
    expect(zPad).to.equal(136n);
    // c3^2 == -12 and 3*c4 == -16 in Fp — the defining relations, checked
    // against the curve itself rather than against either implementation.
    expect((c3 * c3) % BLS.P).to.equal((BLS.P - 12n) % BLS.P);
    expect((c4 * 3n) % BLS.P).to.equal((BLS.P - 16n) % BLS.P);
  });

  it("Solidity hash-to-curve agrees with an independent RFC 9380 implementation", async () => {
    const h = await deployHarness();
    const domainBytes = ethers.toUtf8Bytes(DOMAIN);

    for (const round of [1, 2, 7, 12345, 4_294_967_296]) {
      const msg = BLS.roundMessage(round);

      expect(await h.expandMsgTo96(domainBytes, msg)).to.equal(
        ethers.hexlify(BLS.expandMsgTo96(DOMAIN, msg)),
        `expand_message_xmd mismatch at round ${round}`
      );

      const field = await h.hashToField(domainBytes, msg);
      const expectedField = BLS.hashToField(DOMAIN, msg);
      expect(field[0]).to.equal(expectedField[0]);
      expect(field[1]).to.equal(expectedField[1]);

      const point = await h.hashToPoint(domainBytes, msg);
      const expectedPoint = BLS.hashToPoint(DOMAIN, msg);
      expect(point[0]).to.equal(expectedPoint.x, `x mismatch at round ${round}`);
      expect(point[1]).to.equal(expectedPoint.y, `y mismatch at round ${round}`);

      // And the result is genuinely on the curve, per the contract itself.
      expect(await h.isOnCurveG1([point[0], point[1]])).to.equal(true);
    }
  });

  it("the beacon's message point for a round matches the independent one", async () => {
    const { beacon } = await deployBeacon();
    for (const round of [1, 99, 1_000_000]) {
      const onChain = await beacon.messagePoint(round);
      const offChain = BLS.hashToPoint(DOMAIN, BLS.roundMessage(round));
      expect(onChain[0]).to.equal(offChain.x);
      expect(onChain[1]).to.equal(offChain.y);
    }
  });

  it("ACCEPTS a genuine BLS signature and REJECTS a forged one", async () => {
    const { beacon, pk } = await deployBeacon();
    const round = 12345;

    const sig = BLS.signRound(SK, round);
    // Independently confirmed valid by noble's own pairing, before the chain
    // is asked anything at all. If this were false the test below would be
    // proving nothing.
    expect(BLS.verifyOffChain(sig, pk, round)).to.equal(true);

    await expect(beacon.submitRound(round, sig)).to.emit(beacon, "RoundSubmitted");
    expect(await beacon.isRoundAvailable(round)).to.equal(true);
    expect(await beacon.randomnessAt(round)).to.equal(
      ethers.keccak256(ethers.solidityPacked(["uint256", "uint256"], sig))
    );

    // --- Forgeries. Each is a DIFFERENT way of being wrong. ---

    // 1. A valid signature, but for a different round (replay across rounds).
    const otherRound = 12346;
    const wrongRoundSig = BLS.signRound(SK, otherRound);
    expect(BLS.verifyOffChain(wrongRoundSig, pk, otherRound)).to.equal(true);
    await expect(
      beacon.submitRound(round + 100, wrongRoundSig)
    ).to.be.revertedWithCustomError(beacon, "InvalidSignature");

    // 2. A signature by the WRONG key over the right round.
    const wrongKeySig = BLS.signRound(SK + 1n, round + 1);
    await expect(
      beacon.submitRound(round + 1, wrongKeySig)
    ).to.be.revertedWithCustomError(beacon, "InvalidSignature");

    // 3. A point that is on the curve but is not the signature (H(m) itself).
    const hm = BLS.hashToPoint(DOMAIN, BLS.roundMessage(round + 2));
    await expect(
      beacon.submitRound(round + 2, [hm.x, hm.y])
    ).to.be.revertedWithCustomError(beacon, "InvalidSignature");

    // 4. A point that is NOT on the curve at all — caught before pairing.
    await expect(
      beacon.submitRound(round + 3, [1n, 2n ** 200n])
    ).to.be.revertedWithCustomError(beacon, "InvalidSignaturePoint");

    // 5. The point at infinity, which must never be treated as a signature.
    await expect(
      beacon.submitRound(round + 4, [0n, 0n])
    ).to.be.revertedWithCustomError(beacon, "InvalidSignaturePoint");

    // 6. Field elements out of range.
    await expect(
      beacon.submitRound(round + 5, [BLS.P, 1n])
    ).to.be.revertedWithCustomError(beacon, "InvalidSignaturePoint");

    // NONE of the failures poisoned any cache entry.
    for (const r of [round + 1, round + 2, round + 3, round + 4, round + 5, round + 100]) {
      expect(await beacon.isRoundAvailable(r)).to.equal(false);
      await expect(beacon.randomnessAt(r)).to.be.revertedWithCustomError(
        beacon,
        "RoundNotAvailable"
      );
    }
  });

  it("a round is first-valid-submission-wins: identical resubmission is a no-op, anything else reverts", async () => {
    const { beacon } = await deployBeacon();
    const [, relayerA, relayerB] = await ethers.getSigners();
    const round = 777;
    const sig = BLS.signRound(SK, round);

    // Permissionless: a random address with no relationship to anything relays.
    await beacon.connect(relayerA).submitRound(round, sig);
    const value = await beacon.randomnessAt(round);

    // A racing relayer submitting the SAME signature must not revert (BLS
    // signatures are deterministic, so this is the only valid one anyway).
    await expect(beacon.connect(relayerB).submitRound(round, sig)).to.not.be.reverted;
    expect(await beacon.randomnessAt(round)).to.equal(value);

    // Anything different for the same round is rejected outright — the cached
    // value can never be overwritten, so there is no griefing lever here.
    const other = BLS.signRound(SK, round + 1);
    await expect(beacon.submitRound(round, other)).to.be.revertedWithCustomError(
      beacon,
      "RoundAlreadySubmitted"
    );
    expect(await beacon.randomnessAt(round)).to.equal(value);
  });

  it("round 0 is rejected and the round<->time schedule is drand's", async () => {
    const { beacon } = await deployBeacon();
    await expect(beacon.submitRound(0, [1n, 2n])).to.be.revertedWithCustomError(
      beacon,
      "InvalidRound"
    );
    // drand's real schedule: round 1 is published AT genesis_time, i.e.
    // TimeOfRound(r) = genesis + (r-1)*period, so round_at(t) is
    // floor((t-genesis)/period) + 1. These expectations previously encoded the
    // formula WITHOUT the +1, which is why they passed against the off-by-one
    // (F-1). They are corrected, not relaxed — every value below is one
    // higher, and the "no round exists before genesis" case is unchanged.
    // Cross-checked against real published evmnet data in
    // DrandRoundConvention.test.ts.
    expect(await beacon.currentRoundAt(GENESIS)).to.equal(1n);
    expect(await beacon.currentRoundAt(GENESIS + PERIOD - 1)).to.equal(1n);
    expect(await beacon.currentRoundAt(GENESIS + PERIOD)).to.equal(2n);
    expect(await beacon.currentRoundAt(GENESIS + PERIOD * 10 + 2)).to.equal(11n);
    expect(await beacon.currentRoundAt(GENESIS - 1)).to.equal(0n);
    expect(await beacon.nextRoundAfter(GENESIS + PERIOD * 10 + 2)).to.equal(12n);
    expect(await beacon.nextRoundAfter(GENESIS)).to.equal(2n);
    await expect(beacon.nextRoundAfter(GENESIS - 1)).to.be.revertedWithCustomError(
      beacon,
      "BeforeGenesis"
    );
  });

  it("publicKey and domain survive the storage->immutable move byte-for-byte (G-1)", async () => {
    const { beacon, pk } = await deployBeacon();
    // getPublicKey() and the per-index accessor must return exactly what was
    // passed to the constructor — the whole point of the gas change is that it
    // is invisible from the outside.
    const got = await beacon.getPublicKey();
    for (let i = 0; i < 4; i++) {
      expect(got[i]).to.equal(pk[i]);
      expect(await beacon.publicKey(i)).to.equal(pk[i]);
    }
    expect(await beacon.domain()).to.equal(ethers.hexlify(ethers.toUtf8Bytes(DOMAIN)));
    expect(ethers.toUtf8String(await beacon.domain())).to.equal(DOMAIN);

    // And a DST is reassembled exactly at word boundaries and either side of
    // them, since it is now stored as fixed-size words.
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    for (const len of [1, 31, 32, 33, 63, 64, 65, 127, 128]) {
      const dst = "x".repeat(len);
      const b: any = await Beacon.deploy(
        CHAIN_HASH,
        BLS.publicKeyG2(SK),
        GENESIS,
        PERIOD,
        ethers.toUtf8Bytes(dst)
      );
      expect(await b.domain()).to.equal(
        ethers.hexlify(ethers.toUtf8Bytes(dst)),
        `domain round-trip failed at length ${len}`
      );
      // The DST feeds hash-to-curve, so prove the reassembled bytes produce
      // the same point an independent implementation does.
      const onChain = await b.messagePoint(42);
      const offChain = BLS.hashToPoint(dst, BLS.roundMessage(42));
      expect(onChain[0]).to.equal(offChain.x);
      expect(onChain[1]).to.equal(offChain.y);
    }
    // Past the four-word ceiling it fails closed rather than truncating.
    await expect(
      Beacon.deploy(
        CHAIN_HASH,
        BLS.publicKeyG2(SK),
        GENESIS,
        PERIOD,
        ethers.toUtf8Bytes("x".repeat(129))
      )
    ).to.be.revertedWithCustomError(Beacon, "InvalidDomain");
  });

  it("randomnessOrZero mirrors isRoundAvailable/randomnessAt in one call (G-3)", async () => {
    const { beacon } = await deployBeacon();
    const round = 4242;
    expect(await beacon.randomnessOrZero(round)).to.equal(ethers.ZeroHash);
    expect(await beacon.isRoundAvailable(round)).to.equal(false);

    await beacon.submitRound(round, BLS.signRound(SK, round));
    expect(await beacon.randomnessOrZero(round)).to.equal(await beacon.randomnessAt(round));
    // Never zero for a relayed round — the vault's guard treats zero as
    // "not available", so a verified round hashing to zero would be a silent
    // stall rather than a wrong draw, but it must not happen at all.
    expect(await beacon.randomnessOrZero(round)).to.not.equal(ethers.ZeroHash);
  });

  it("refuses to deploy with a public key that is not a G2 point", async () => {
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    await expect(
      Beacon.deploy(CHAIN_HASH, [1n, 2n, 3n, 4n], GENESIS, PERIOD, ethers.toUtf8Bytes(DOMAIN))
    ).to.be.revertedWithCustomError(Beacon, "InvalidPublicKey");
    await expect(
      Beacon.deploy(CHAIN_HASH, BLS.publicKeyG2(SK), GENESIS, 0, ethers.toUtf8Bytes(DOMAIN))
    ).to.be.revertedWithCustomError(Beacon, "InvalidPeriod");
    await expect(
      Beacon.deploy(CHAIN_HASH, BLS.publicKeyG2(SK), GENESIS, PERIOD, "0x")
    ).to.be.revertedWithCustomError(Beacon, "InvalidDomain");
  });

  /**
   * INTEROPERABILITY GATE — the one thing this sandbox could NOT prove.
   *
   * Everything above shows the verifier is a correct, sound BLS/BN254
   * implementation. It does NOT show it is byte-compatible with the real drand
   * network, because that requires the real public key and a real published
   * round, and there was no network access here.
   *
   * To close it, fetch (no key, no permission, plain HTTP):
   *   curl https://api.drand.sh/<chainHash>/info
   *   curl https://api.drand.sh/<chainHash>/public/<round>
   * and write test/contracts/fixtures/drand-round.json:
   *   {
   *     "publicKey": ["<x_imag>","<x_real>","<y_imag>","<y_real>"],
   *     "domain": "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_",
   *     "genesis": 1234567890, "period": 3,
   *     "chainHash": "0x...",
   *     "round": 1234567,
   *     "signature": ["<x>", "<y>"]
   *   }
   * (decimal or 0x-hex strings both work.)
   *
   * DO NOT DEPLOY WITH REAL VALUE UNTIL THIS TEST RUNS AND PASSES.
   */
  it("verifies a REAL drand round (skipped unless fixtures/drand-round.json exists)", async function () {
    const fixturePath = path.join(__dirname, "fixtures", "drand-round.json");
    if (!fs.existsSync(fixturePath)) {
      this.skip();
      return;
    }
    const fx = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon: any = await Beacon.deploy(
      fx.chainHash,
      fx.publicKey.map((v: string) => BigInt(v)),
      BigInt(fx.genesis),
      BigInt(fx.period),
      ethers.toUtf8Bytes(fx.domain)
    );
    await expect(
      beacon.submitRound(BigInt(fx.round), fx.signature.map((v: string) => BigInt(v)))
    ).to.emit(beacon, "RoundSubmitted");
  });
});
