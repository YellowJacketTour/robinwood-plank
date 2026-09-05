import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";
import * as BLS from "./helpers/bls-bn254.js";

/**
 * C.8 randomness invariants D-1 / D-2 stated explicitly against the LIVE
 * beacon contract (the deployed, shared DrandBeacon is KEPT unchanged).
 *
 *  D-1  a signature verifies iff it is the drand signature for THAT round.
 *       The full negative matrix (wrong round, wrong key, on-curve non-sig,
 *       off-curve, infinity, out-of-range coordinates) is proven in
 *       DrandBeacon.bls.test.ts; this file re-asserts the iff with fresh
 *       rounds and adds the cross-round replay case.
 *  D-2  a submitted round is immutable. NOTE: the live beacon has NO
 *       emission-time gate on submission (audit A.3.1): a far-future round is
 *       accepted iff it verifies, which only a colluding drand threshold could
 *       produce. Adding a `round <= currentRoundAt(now)+k` bound requires a new
 *       beacon deployment and is DEFERRED; PlankCrash's own protection is that
 *       it commits to a target strictly after betting closes, so no valid
 *       signature can exist for it while seats are still being committed.
 */
describe("DrandBeacon -- C.8 D-1 / D-2", () => {
  const SK = 0x1d3f5b7a9c2e4f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718n % BLS.R;
  const GENESIS = 1_700_000_000;
  const PERIOD = 3;

  async function deployBeacon() {
    const pk = BLS.publicKeyG2(SK);
    const Beacon = await ethers.getContractFactory("DrandBeacon");
    const beacon: any = await Beacon.deploy(ethers.id("test-chain-hash"), pk, GENESIS, PERIOD, ethers.toUtf8Bytes(BLS.DRAND_BN254_DOMAIN));
    return { beacon, pk };
  }

  it("D-1: verifies iff the signature is the drand signature for that exact round", async () => {
    const { beacon, pk } = await deployBeacon();
    for (const round of [1001, 1002, 424242]) {
      const sig = BLS.signRound(SK, round);
      expect(BLS.verifyOffChain(sig, pk, round)).to.equal(true);
      // The right signature for ANOTHER round never verifies for this one.
      await expect(beacon.submitRound(round, BLS.signRound(SK, round + 1))).to.be.revertedWithCustomError(beacon, "InvalidSignature");
      await expect(beacon.submitRound(round, BLS.signRound(SK + 7n, round))).to.be.revertedWithCustomError(beacon, "InvalidSignature");
      expect(await beacon.isRoundAvailable(round)).to.equal(false);
      await expect(beacon.submitRound(round, sig)).to.emit(beacon, "RoundSubmitted");
      expect(await beacon.randomnessAt(round)).to.equal(ethers.keccak256(ethers.solidityPacked(["uint256", "uint256"], sig)));
    }
  });

  it("D-2: a submitted round is immutable -- a different value for the same round always reverts; the value is the pure hash of the signature", async () => {
    const { beacon } = await deployBeacon();
    const round = 9000;
    const sig = BLS.signRound(SK, round);
    await beacon.submitRound(round, sig);
    const value = await beacon.randomnessAt(round);
    await expect(beacon.submitRound(round, BLS.signRound(SK, round + 1))).to.be.revertedWithCustomError(beacon, "RoundAlreadySubmitted");
    await expect(beacon.submitRound(round, [1n, 2n])).to.be.revertedWithCustomError(beacon, "RoundAlreadySubmitted");
    await beacon.submitRound(round, sig); // identical resubmission is a no-op
    expect(await beacon.randomnessAt(round)).to.equal(value);
    expect(await beacon.randomnessOrZero(round)).to.equal(value);
  });
});
