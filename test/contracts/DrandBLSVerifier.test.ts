import { expect } from "chai";
import { ethers } from "./helpers/hardhat.js";

/**
 * Proves DrandBLSVerifier's actual BN254 pairing math is correct using
 * REAL, historical drand evmnet signatures -- not a mock, not a
 * synthetic fixture. Fetched for real from https://api.drand.sh/v2/beacons/evmnet/rounds/{round}
 * at the time this file was written:
 *
 *   curl https://api.drand.sh/v2/beacons/evmnet/rounds/19700000
 *   -> {"round":19700000,"signature":"044f4e4a...0557ab"}
 *   curl https://api.drand.sh/v2/beacons/evmnet/rounds/19700100
 *   -> {"round":19700100,"signature":"2e516cc7...041a623ec"}
 *
 * Each 128-hex-char signature is a G1 point: the first 64 hex chars are
 * the x coordinate, the last 64 are y (see DrandBLSVerifier.sol's
 * verifyRound() -- BLS.verifySingle takes signature as [x, y]). This is
 * strictly stronger evidence than testing against a mock: it proves the
 * verifier accepts the real League of Entropy network's actual output,
 * against the real public key hardcoded in the contract (also fetched
 * for real from https://api.drand.sh/v2/beacons/evmnet/info and
 * decomposed via @kevincharm/noble-bn254-drand -- see
 * PlankCrashDrand.sol's header for that derivation).
 */
describe("DrandBLSVerifier", () => {
  const REAL_ROUND_1 = 19700000n;
  const REAL_SIGNATURE_1: [bigint, bigint] = [
    1949372652777623059452286480617121015258151223408003143426288109451940808146n,
    15774059631938790910616310917835606469673169251013786491967954562235893110699n,
  ];
  const REAL_ROUND_2 = 19700100n;
  const REAL_SIGNATURE_2: [bigint, bigint] = [
    20950256418417065920977812437203862801038010837790899356304875781433301908601n,
    9597408316525781342941511535095114135494513604930973475169243555955739075564n,
  ];

  async function deploy() {
    const Verifier = await ethers.getContractFactory("DrandBLSVerifier");
    const verifier: any = await Verifier.deploy();
    return { verifier };
  }

  it("accepts a real drand evmnet signature for its real round number (round 19700000)", async () => {
    const { verifier } = await deploy();
    expect(await verifier.verifyRound(REAL_ROUND_1, REAL_SIGNATURE_1)).to.equal(true);
  });

  it("accepts a second, independent real drand evmnet signature for its real round number (round 19700100)", async () => {
    const { verifier } = await deploy();
    expect(await verifier.verifyRound(REAL_ROUND_2, REAL_SIGNATURE_2)).to.equal(true);
  });

  it("rejects a real signature submitted against the WRONG round number -- proves the round is actually bound into the check, not ignored", async () => {
    const { verifier } = await deploy();
    // Round 1's real signature, claimed for round 2's number.
    expect(await verifier.verifyRound(REAL_ROUND_2, REAL_SIGNATURE_1)).to.equal(false);
  });

  it("rejects a tampered signature (one coordinate flipped) for a real, otherwise-valid round", async () => {
    const { verifier } = await deploy();
    const tampered: [bigint, bigint] = [REAL_SIGNATURE_1[0] + 1n, REAL_SIGNATURE_1[1]];
    expect(await verifier.verifyRound(REAL_ROUND_1, tampered)).to.equal(false);
  });

  it("rejects an out-of-field signature outright, before ever reaching the pairing check", async () => {
    const { verifier } = await deploy();
    const N = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
    expect(await verifier.verifyRound(REAL_ROUND_1, [N, N])).to.equal(false);
  });
});
